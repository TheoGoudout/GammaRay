// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { resolve as resolvePath } from 'node:path';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import type { AppInfo, OwnedProcess, QtApp } from './app';
import { Connection } from './connection';
import { localProcess, setUpApp, startProcess, type LaunchOptions } from './launcher';

// Remote launching: `qt-playwright server` runs on the machine (or device) with the
// application; tests elsewhere call launch(app, args, { remote: 'host:port' }).
//
// Protocol, over one WebSocket per application:
//   client -> server  {"qtpw":"launch","executable":...,"args":[...],"options":{...}}
//   server -> client  JSON-RPC notifications "qtpw.output" {text} with the app's output,
//                     then {"qtpw":"launched"} (or {"qtpw":"error","message"} and close)
// After "launched" the server relays all messages between the client and the automation
// server inside the application (text and binary, e.g. video frames), so the automation
// server keeps listening on 127.0.0.1 only. Closing the socket terminates the application,
// and the socket closes when the application exits.

/** Launch options a remote server accepts (everything else applies on the client side). */
const REMOTE_OPTIONS = ['env', 'cwd', 'headless', 'disabledPlugins', 'probeAbi', 'injector', 'timeout'] as const;

function remoteTarget(remote: NonNullable<LaunchOptions['remote']>): { url: string; token?: string } {
  const r = typeof remote === 'string' ? { url: remote } : remote;
  const url = /^wss?:\/\//.test(r.url) ? r.url : `ws://${r.url}`;
  return { url, token: r.token ?? process.env.QTPW_SERVER_TOKEN };
}

/** launch() with the `remote` option. */
export async function launchRemote(appPath: string, args: string[], options: LaunchOptions): Promise<QtApp> {
  const { url, token } = remoteTarget(options.remote!);
  const timeout = options.timeout ?? 30_000;
  const ws = new WebSocket(url, { perMessageDeflate: false, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let output = '';
  const printOutput = options.printOutput ?? !!process.env.QT_PLAYWRIGHT_DEBUG;
  const onOutput = (text: string) => {
    if (printOutput) process.stdout.write(text);
    output = (output + text).slice(-256 * 1024);
  };

  // until "launched", messages come from the server itself
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => fail(`no response within ${timeout} ms`), timeout + 5_000);
    const fail = (why: string) => {
      clearTimeout(timer);
      ws.removeAllListeners('message');
      ws.terminate();
      reject(new Error(`Failed to launch ${appPath} on ${url}: ${why}${output ? `\n--- output ---\n${output}` : ''}`));
    };
    ws.once('unexpected-response', (_req, res) =>
      fail(res.statusCode === 401 ? 'the server rejected the token (set remote.token or QTPW_SERVER_TOKEN)' : `HTTP ${res.statusCode}`),
    );
    ws.once('error', (err) => fail(err.message));
    ws.once('close', () => fail('the server closed the connection'));
    ws.once('open', () => {
      const remoteOptions: Record<string, unknown> = {};
      for (const k of REMOTE_OPTIONS) if (options[k] !== undefined) remoteOptions[k] = options[k];
      ws.send(JSON.stringify({ qtpw: 'launch', executable: appPath, args, options: remoteOptions }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      if (msg.method === 'qtpw.output') onOutput(String(msg.params?.text ?? ''));
      else if (msg.qtpw === 'error') fail(String(msg.message));
      else if (msg.qtpw === 'launched') {
        clearTimeout(timer);
        ws.removeAllListeners('message');
        ws.removeAllListeners('close');
        ws.removeAllListeners('error');
        ws.removeAllListeners('unexpected-response');
        resolve();
      }
    });
  });

  // from now on the socket talks to the automation server in the application
  const connection = Connection.fromSocket(ws, url);
  connection.on('qtpw.output', (params: { text?: string }) => onOutput(String(params?.text ?? '')));
  let info: AppInfo;
  try {
    info = await connection.call<AppInfo>('hello');
  } catch (e) {
    connection.close();
    throw e;
  }
  const closed = new Promise<void>((resolve) => (ws.readyState === WebSocket.CLOSED ? resolve() : ws.once('close', () => resolve())));
  const owned: OwnedProcess = {
    output: () => output,
    isRunning: () => !connection.isClosed,
    // closing the socket makes the server terminate the application
    terminate: () => closed,
  };
  return setUpApp(connection, info, owned, options);
}

export interface ServerOptions {
  /** Interface to listen on (default 127.0.0.1: reach it through an SSH tunnel). */
  host?: string;
  /** Port (default 9900). */
  port?: number;
  /**
   * Token clients must send (Authorization: Bearer <token>). Default: $QTPW_SERVER_TOKEN,
   * else a random one, printed at startup. Pass an empty string to accept any client.
   */
  token?: string;
  /** Executables clients may launch (absolute paths). Default: any. */
  apps?: string[];
  /** The gammaray launcher on this machine. */
  gammaray?: string;
  /** Called with log lines (default: stderr). */
  log?: (line: string) => void;
}

export interface RunningServer {
  /** ws://host:port */
  url: string;
  token: string;
  close(): Promise<void>;
}

function tokenMatches(req: IncomingMessage, token: string): boolean {
  if (!token) return true;
  const given = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Runs `qt-playwright server`: launches applications for remote tests and relays their
 * automation connection (see the protocol above).
 */
export async function runServer(options: ServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const token = options.token ?? process.env.QTPW_SERVER_TOKEN ?? randomBytes(16).toString('hex');
  const apps = options.apps?.map((a) => resolvePath(a));
  const host = options.host ?? '127.0.0.1';
  const server = new WebSocketServer({
    host,
    port: options.port ?? 9900,
    perMessageDeflate: false,
    verifyClient: ({ req }, done) => (tokenMatches(req, token) ? done(true) : done(false, 401, 'Unauthorized')),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address() as { port: number };
  const sessions = new Set<() => void>();

  server.on('connection', (client, req) => {
    const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    let stop: (() => void) | undefined;
    const send = (msg: object) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(msg));
    client.once('message', async (data: RawData) => {
      let request: { qtpw?: string; executable?: string; args?: string[]; options?: LaunchOptions };
      try {
        request = JSON.parse(data.toString());
      } catch {
        request = {};
      }
      if (request.qtpw !== 'launch' || !request.executable) {
        send({ qtpw: 'error', message: 'expected a launch request' });
        client.close();
        return;
      }
      const executable = request.executable;
      if (apps && !apps.includes(resolvePath(executable))) {
        log(`${peer}: refused to launch ${executable} (not in --app)`);
        send({ qtpw: 'error', message: `this server does not launch ${executable}` });
        client.close();
        return;
      }
      const launchOptions: LaunchOptions = {};
      for (const k of REMOTE_OPTIONS) if (request.options?.[k] !== undefined) (launchOptions as Record<string, unknown>)[k] = request.options[k];
      log(`${peer}: launching ${executable} ${(request.args ?? []).join(' ')}`);
      let started;
      try {
        started = await startProcess(executable, request.args ?? [], {
          ...launchOptions,
          gammaray: options.gammaray,
          printOutput: false,
          onOutput: (text) => send({ jsonrpc: '2.0', method: 'qtpw.output', params: { text } }),
        });
      } catch (e) {
        log(`${peer}: ${(e as Error).message.split('\n')[0]}`);
        send({ qtpw: 'error', message: (e as Error).message });
        client.close();
        return;
      }
      const owned = localProcess(started.launcher, started.output);
      const app = new WebSocket(started.url, { perMessageDeflate: false });
      let pid = 0;
      let stopped = false;
      stop = () => {
        if (stopped) return;
        stopped = true;
        app.terminate();
        if (client.readyState === WebSocket.OPEN) client.close();
        if (owned.isRunning()) {
          // the launcher's child is the application; terminate() signals it by pid
          void (pid ? owned.terminate(pid) : Promise.resolve(started.launcher.kill('SIGTERM')));
        }
        sessions.delete(stop!);
      };
      sessions.add(stop);
      app.on('message', (msg, isBinary) => {
        if (!pid && !isBinary) {
          // remember the pid from the hello reply, to terminate the application itself
          const m = /"pid":(\d+)/.exec(msg.toString());
          if (m) pid = Number(m[1]);
        }
        if (client.readyState === WebSocket.OPEN) client.send(msg, { binary: isBinary });
      });
      app.once('open', () => {
        client.on('message', (msg, isBinary) => app.readyState === WebSocket.OPEN && app.send(msg, { binary: isBinary }));
        send({ qtpw: 'launched' });
        log(`${peer}: connected to ${executable}`);
      });
      app.on('error', () => stop?.());
      app.on('close', () => stop?.());
      started.launcher.once('exit', () => stop?.());
    });
    client.on('close', () => {
      if (stop) {
        log(`${peer}: disconnected, terminating the application`);
        stop();
      }
    });
    client.on('error', () => client.terminate());
  });

  const url = `ws://${host}:${address.port}`;
  return {
    url,
    token,
    close: async () => {
      for (const stop of [...sessions]) stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
