// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Video, type RecordVideoOptions } from './video';
import { AppInfo, QtApp } from './app';
import { Connection } from './connection';
import { TimeoutError } from './errors';
import { poll } from './wait';

/** GammaRay tool plugins disabled by default: not needed for automation, and some change app behavior. */
export const DEFAULT_DISABLED_PLUGINS = [
  'gammaray_widgetinspector', // makes modal dialogs non-modal
  'gammaray_guisupport', // appends " (Injected by GammaRay)" to window titles, replaces window icons
  'gammaray_quickinspector',
  'gammaray_sceneinspector',
  'gammaray_styleinspector',
  'gammaray_signalmonitor', // global signal spy callback
  'gammaray_eventmonitor', // global event filter
  'gammaray_timertop',
  'gammaray_modelinspector',
  'gammaray_actioninspector',
  'gammaray_fontbrowser',
  'gammaray_textdocumentinspector',
  'gammaray_localeinspector',
  'gammaray_translationinspector',
  'gammaray_mimetypes',
  'gammaray_network',
  'gammaray_sysinfo',
  'gammaray_webinspector',
  'gammaray_wlcompositorinspector',
  'gammaray_statemachineviewer',
  'gammaray_3dinspector',
  'gammaray_kjobtracker',
  'gammaray_bluetooth',
  'gammaray_positioning',
];

export interface CommonOptions {
  /** Path to the `gammaray` launcher; defaults to $QT_PLAYWRIGHT_GAMMARAY, then `gammaray` in PATH. */
  gammaray?: string;
  /** Time to wait for the application to come up, in ms (default 30000). */
  timeout?: number;
  /** Probe ABI to use (see `gammaray --list-probes`); auto-detected by default. */
  probeAbi?: string;
  /** Injector to use (e.g. "preload", "gdb", "lldb", "style"). */
  injector?: string;
}

export interface LaunchOptions extends CommonOptions {
  /** Extra environment variables for the application (merged into process.env). */
  env?: Record<string, string | undefined>;
  cwd?: string;
  /**
   * Run without a display (default: true when no DISPLAY/WAYLAND_DISPLAY is set):
   * sets QT_QPA_PLATFORM=offscreen and QT_QUICK_BACKEND=software unless given in `env`.
   */
  headless?: boolean;
  /** Port of the automation server inside the app; 0 (default) picks a free one. */
  automationPort?: number;
  /** GammaRay plugins to disable; defaults to DEFAULT_DISABLED_PLUGINS. */
  disabledPlugins?: string[];
  /** Mirror the application's stdout/stderr to this process (default: $QT_PLAYWRIGHT_DEBUG set). */
  printOutput?: boolean;
  /** Default timeout of the returned app (actions, waits, assertions). */
  defaultTimeout?: number;
  /** Timeout of expect() assertions (default: defaultTimeout). */
  expectTimeout?: number;
  /** Slows down every action by this many milliseconds (handy for watching or recording). */
  slowMo?: number;
  /** Record a video of the session into `dir` (see QtApp.video()), like Playwright's recordVideo. */
  recordVideo?: RecordVideoOptions;
}

export interface AttachOptions extends CommonOptions {
  /** Where the probe writes its port file (default: $TMPDIR/gammaray-automation-<pid>.json). */
  portFile?: string;
  defaultTimeout?: number;
}

const LISTENING_RE = /GammaRay automation server listening on (ws:\/\/\S+)/;
const MAX_OUTPUT = 256 * 1024;

function gammarayPath(options: CommonOptions): string {
  return options.gammaray ?? process.env.QT_PLAYWRIGHT_GAMMARAY ?? 'gammaray';
}

function injectorArgs(options: CommonOptions): string[] {
  const args: string[] = [];
  if (options.probeAbi) args.push('--probe', options.probeAbi);
  if (options.injector) args.push('--injector', options.injector);
  return args;
}

async function handshake(url: string, timeout: number) {
  const connection = await Connection.connect(url, timeout);
  const info = await connection.call<AppInfo>('hello');
  return { connection, info };
}

/**
 * Starts @p appPath under GammaRay with the automation server enabled and connects to it.
 *
 *   const app = await launch('./build/myapp', ['--some-arg']);
 *   await app.locator('#okButton').click();
 *   await app.close();
 */
export async function launch(appPath: string, args: string[] = [], options: LaunchOptions = {}): Promise<QtApp> {
  const timeout = options.timeout ?? 30_000;
  const headless = options.headless ?? !(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...options.env })) if (v !== undefined) env[k] = v;
  if (headless) {
    // also needed by the launcher itself, which is a Qt GUI application
    env.QT_QPA_PLATFORM ??= 'offscreen';
    env.QT_QUICK_BACKEND ??= 'software';
  }
  env.GAMMARAY_AUTOMATION_PORT = String(options.automationPort ?? 0);
  env.GAMMARAY_DisabledPlugins ??= (options.disabledPlugins ?? DEFAULT_DISABLED_PLUGINS).join(';');
  env.GAMMARAY_LAUNCHER_TIMEOUT ??= String(Math.ceil(timeout / 1000));

  const argv = ['--inject-only', '--listen', 'tcp://127.0.0.1', ...injectorArgs(options), appPath, ...args];
  const launcher = spawn(gammarayPath(options), argv, {
    cwd: options.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const printOutput = options.printOutput ?? !!process.env.QT_PLAYWRIGHT_DEBUG;
  let onLine: ((line: string) => void) | undefined;
  let partial = '';
  const onData = (chunk: Buffer, stream: NodeJS.WriteStream) => {
    const text = chunk.toString();
    if (printOutput) stream.write(text);
    output = (output + text).slice(-MAX_OUTPUT);
    partial += text;
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const l of lines) onLine?.(l);
  };
  launcher.stdout!.on('data', (c: Buffer) => onData(c, process.stdout));
  launcher.stderr!.on('data', (c: Buffer) => onData(c, process.stderr));

  const url = await new Promise<string>((resolve, reject) => {
    const fail = (why: string) => {
      clearTimeout(timer);
      launcher.kill('SIGKILL');
      reject(new Error(`Failed to launch ${appPath}: ${why}\n--- output ---\n${output}`));
    };
    const timer = setTimeout(
      () => fail(`no automation server came up within ${timeout} ms (is the gammaray_automation plugin installed?)`),
      timeout,
    );
    onLine = (line) => {
      const m = LISTENING_RE.exec(line);
      if (m) {
        clearTimeout(timer);
        onLine = undefined;
        resolve(m[1]);
      }
    };
    launcher.once('error', (err) => fail(`could not start ${gammarayPath(options)}: ${err.message}`));
    launcher.once('exit', (code, signal) => fail(`launcher exited (code ${code}, signal ${signal})`));
  });
  launcher.removeAllListeners('exit');
  launcher.removeAllListeners('error');
  launcher.on('error', () => undefined);

  try {
    const { connection, info } = await handshake(url, timeout);
    const app = new QtApp(connection, info, { launcher, output: () => output });
    if (options.defaultTimeout) app.setDefaultTimeout(options.defaultTimeout);
    app.slowMo = options.slowMo ?? 0;
    app.expectTimeout = options.expectTimeout;
    if (options.recordVideo) {
      const { dir, format, ...videoOptions } = options.recordVideo;
      const path = join(dir, `${randomUUID()}.${format ?? 'mp4'}`);
      try {
        app.setRecordedVideo(await Video.start(connection, path, videoOptions));
      } catch (e) {
        await app.close().catch(() => undefined);
        throw e;
      }
    }
    return app;
  } catch (e) {
    launcher.kill('SIGKILL');
    throw e;
  }
}

/**
 * Connects to an application that already runs the automation server:
 *  - a URL ("ws://host:port") or "host:port" connects directly (e.g. remote/embedded targets
 *    started with GAMMARAY_AUTOMATION_PORT=<port> GAMMARAY_AUTOMATION_ADDRESS=0.0.0.0);
 *  - a pid injects the GammaRay probe into the running process (needs gdb/lldb and ptrace
 *    permissions) and enables the automation server in it.
 */
export async function attach(target: number | string, options: AttachOptions = {}): Promise<QtApp> {
  const timeout = options.timeout ?? 30_000;
  let url: string;
  if (typeof target === 'string') {
    url = target.startsWith('ws://') || target.startsWith('wss://') ? target : `ws://${target}`;
  } else {
    url = await injectIntoPid(target, options, timeout);
  }
  const { connection, info } = await handshake(url, timeout);
  const app = new QtApp(connection, info);
  if (options.defaultTimeout) app.setDefaultTimeout(options.defaultTimeout);
  return app;
}

async function readPortFile(path: string): Promise<string | undefined> {
  try {
    const info = JSON.parse(await readFile(path, 'utf8'));
    return typeof info.url === 'string' ? info.url : undefined;
  } catch {
    return undefined;
  }
}

async function injectIntoPid(pid: number, options: AttachOptions, timeout: number): Promise<string> {
  const portFile = options.portFile ?? join(tmpdir(), `gammaray-automation-${pid}.json`);
  // already injected with automation enabled?
  const existing = await readPortFile(portFile);
  if (existing) {
    try {
      (await Connection.connect(existing, 2_000)).close();
      return existing;
    } catch {
      // stale port file, inject again
    }
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.QT_QPA_PLATFORM ??= process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? '' : 'offscreen';
  if (!env.QT_QPA_PLATFORM) delete env.QT_QPA_PLATFORM;

  const argv = [
    '--inject-only',
    '--listen',
    'tcp://127.0.0.1',
    '--probe-setting',
    'AutomationPort=0',
    ...injectorArgs(options),
    '--pid',
    String(pid),
  ];
  let output = '';
  const launcher = spawn(gammarayPath(options), argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  launcher.stdout!.on('data', (c: Buffer) => (output += c.toString()));
  launcher.stderr!.on('data', (c: Buffer) => (output += c.toString()));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    launcher.once('error', (err) => reject(new Error(`could not start ${gammarayPath(options)}: ${err.message}`)));
    launcher.once('exit', (code) => resolve(code));
  });
  if (exitCode !== 0) throw new Error(`Failed to attach to pid ${pid} (exit code ${exitCode}):\n${output}`);

  try {
    return await poll(`attach(${pid})`, timeout, async () => {
      const url = await readPortFile(portFile);
      return { done: !!url, value: url, log: `waiting for ${portFile}` };
    });
  } catch (e) {
    if (e instanceof TimeoutError)
      throw new TimeoutError(`${e.message}\nThe probe was injected but no automation server reported in. Launcher output:\n${output}`);
    throw e;
  }
}
