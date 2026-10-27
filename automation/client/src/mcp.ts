// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

// MCP (Model Context Protocol) server: lets AI agents drive a Qt application live, the way
// Playwright MCP drives a browser. The agent reads accessibility snapshots whose elements
// carry refs ("[ref=e42]", the element handle), acts on refs or on locator expressions,
// checks state with the retrying assertions, and can turn what it did into a test.
//
//   qt-playwright mcp [--app <executable>] [--remote host:port] [--connect host:port] ...
//
// Everything goes through the regular qt-playwright API (launch/connect/attach, Locator,
// expect, tracing, video), so remote applications work through `qt-playwright server` or
// a directly reachable automation port.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { QtApp } from './app';
import { handleForRef, refForHandle, renderAriaSnapshot, type AriaNode } from './aria';
import { renderTestFile } from './codegen';
import { ErrorCode, QtError } from './errors';
import { expect } from './expect';
import { attach, connect, launch, type LaunchOptions } from './launcher';
import type { Locator } from './locator';
import { parseLocator } from './locatorexpr';
import type { SignalSpy } from './signalspy';
import type { Modifier, MouseButton } from './types';
import type { Video } from './video';
import { sleep } from './wait';

const VERSION: string = require('../package.json').version;

export interface McpServerOptions {
  /**
   * Executables qt_launch may start; the first one is the default (launched automatically
   * by the first tool call that needs an application). Default: any executable, none launched
   * automatically.
   */
  apps?: string[];
  /** Arguments for the automatically launched default application. */
  args?: string[];
  /** Extra environment variables for launched applications. */
  env?: Record<string, string>;
  /** Launch through a `qt-playwright server` on another machine (paths refer to that machine). */
  remote?: string | { url: string; token?: string };
  /** Connect to this automation server (e.g. a device: "host:port") instead of launching. */
  connect?: string;
  /** Run launched applications without a display (default: when there is none). */
  headless?: boolean;
  /** The gammaray launcher (default: $QT_PLAYWRIGHT_GAMMARAY, else from PATH). */
  gammaray?: string;
  /** Timeout of actions, waits and assertions in ms (default 5000). */
  timeout?: number;
  /** Directory for screenshots, traces, videos and generated tests (default: a temp dir). */
  outputDir?: string;
  /** Include a fresh snapshot in the result of every action (default true). */
  snapshotAfterAction?: boolean;
  /** Maximum length of a snapshot in characters before it is truncated (default 40000). */
  maxSnapshotLength?: number;
}

type Content = CallToolResult['content'];
type ToolResult = CallToolResult;

/** Tool errors with a message meant for the agent (no stack). */
class ToolError extends Error {}

/** Strings like "/pattern/flags" are regular expressions in expected values. */
function toMatcher(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(toMatcher);
  if (typeof v !== 'string') return v;
  const m = /^\/(.+)\/([dgimsuy]*)$/s.exec(v);
  return m ? new RegExp(m[1], m[2]) : v;
}

/** Formats a value as TypeScript source for the generated code. */
export function codeLiteral(v: unknown): string {
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  if (v instanceof RegExp) return String(v);
  if (Array.isArray(v)) return `[${v.map(codeLiteral).join(', ')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (!entries.length) return '{}';
    return `{ ${entries.map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : codeLiteral(k)}: ${codeLiteral(x)}`).join(', ')} }`;
  }
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

/** How the expected value of each assertion is passed (see LocatorAssertions). */
const LOCATOR_MATCHERS = {
  toBeVisible: 'none',
  toBeHidden: 'none',
  toBeEnabled: 'none',
  toBeDisabled: 'none',
  toBeEditable: 'none',
  toBeChecked: 'none',
  toBeAttached: 'none',
  toBeFocused: 'none',
  toBeEmpty: 'none',
  toBeInViewport: 'none',
  toHaveText: 'text',
  toContainText: 'text',
  toHaveValue: 'text',
  toHaveValues: 'text',
  toHaveAccessibleName: 'text',
  toHaveAccessibleDescription: 'text',
  toHaveId: 'text',
  toHaveClass: 'text',
  toHaveRole: 'value',
  toHaveCount: 'value',
  toMatchAriaSnapshot: 'value',
  toHaveProperty: 'named',
  toHaveAttribute: 'namedText',
  toHaveCSS: 'namedText',
} as const;
const APP_MATCHERS = { toHaveTitle: 'text', toMatchAriaSnapshot: 'value' } as const;

/** Suffix of @p current that was not in @p previous (application output is a bounded tail). */
export function newOutput(previous: string, current: string): string {
  if (!previous) return current;
  if (current.startsWith(previous)) return current.slice(previous.length);
  // the buffer dropped its beginning: continue after the last known piece
  const anchor = previous.slice(-200);
  const at = current.lastIndexOf(anchor);
  return at >= 0 ? current.slice(at + anchor.length) : current;
}

const text = (t: string) => ({ type: 'text' as const, text: t });

/** Children per element in full-application snapshots (more are summarized). */
const MAX_CHILDREN = 20;

/**
 * State shared by the tools: the connected application, the code of the actions done so far,
 * spies, tracing and video. One application at a time; all MCP sessions of a server share it.
 */
export class McpContext {
  private current: QtApp | undefined;
  private description = '';
  /** qtApp configuration of the `app` fixture that starts the application like this session did. */
  private fixture: string | undefined;
  /** The last full snapshot an agent got, to report "unchanged" instead of repeating it. */
  lastSnapshot: string | undefined;
  private lastExit: string | undefined;
  private connecting: Promise<QtApp> | undefined;
  private seenOutput = '';
  readonly code: string[] = [];
  private spies = new Map<string, SignalSpy>();
  private nextSpy = 1;
  private video: Video | undefined;
  readonly outputDir: string;
  readonly timeout: number;

  constructor(readonly options: McpServerOptions = {}) {
    this.outputDir = resolvePath(options.outputDir ?? join(tmpdir(), `qt-playwright-mcp-${process.pid}`));
    this.timeout = options.timeout ?? 5_000;
  }

  get app(): QtApp | undefined {
    return this.current;
  }

  /** How the application was started, e.g. "launched ./app --flag" or "connected to device:9910". */
  get session(): string {
    return this.description;
  }

  /** The connected application; connects or launches the configured one if there is none. */
  async ensureApp(): Promise<QtApp> {
    if (this.current && !this.current.isRunning()) this.forget('the application exited');
    if (this.current) return this.current;
    if (this.connecting) return this.connecting;
    if (this.options.connect) return this.connectTo(this.options.connect);
    if (this.options.apps?.length) return this.launch(this.options.apps[0], this.options.args ?? []);
    const exited = this.lastExit ? ` (${this.lastExit})` : '';
    throw new ToolError(`No application is connected${exited}. Start one with qt_launch, or use qt_connect / qt_attach.`);
  }

  private forget(why: string): void {
    const output = this.current?.output().slice(-2000);
    this.lastExit = `${why}${output ? `; last output:\n${output}` : ''}`;
    this.current = undefined;
    this.spies.clear();
    this.video = undefined;
  }

  private async adopt(pending: Promise<QtApp>, description: string, fixture?: string): Promise<QtApp> {
    this.connecting = pending;
    try {
      const app = await pending;
      app.setDefaultTimeout(this.timeout);
      this.current = app;
      this.description = description;
      this.fixture = fixture;
      this.lastSnapshot = undefined;
      this.lastExit = undefined;
      this.seenOutput = '';
      app.on('close', () => {
        if (this.current === app) this.forget('the connection to the application was lost (did it exit or crash?)');
      });
      return app;
    } finally {
      this.connecting = undefined;
    }
  }

  checkExecutable(executable: string): void {
    const apps = this.options.apps;
    if (apps?.length && !apps.some((a) => resolvePath(a) === resolvePath(executable)))
      throw new ToolError(`This server only launches ${apps.join(', ')} (see --app).`);
  }

  async launch(executable: string, args: string[], extra: Partial<LaunchOptions> = {}): Promise<QtApp> {
    this.checkExecutable(executable);
    await this.close();
    const options: LaunchOptions = {
      gammaray: this.options.gammaray,
      headless: this.options.headless,
      remote: this.options.remote,
      env: this.options.env,
      timeout: 60_000,
      ...extra,
      // the MCP server may talk over stdout: never mirror the application's output there
      printOutput: false,
      defaultTimeout: this.timeout,
    };
    const remoteUrl = options.remote && (typeof options.remote === 'string' ? options.remote : options.remote.url);
    const fixture = { executable, args: args.length ? args : undefined, env: extra.env, cwd: extra.cwd, remote: remoteUrl ? { url: remoteUrl } : undefined };
    return this.adopt(
      launch(executable, args, options),
      `launched ${[executable, ...args].join(' ')}${remoteUrl ? ` on ${remoteUrl}` : ''}`,
      `qtApp: ${codeLiteral(fixture)}`,
    );
  }

  async connectTo(target: string): Promise<QtApp> {
    await this.close();
    return this.adopt(connect(target, { defaultTimeout: this.timeout }), `connected to ${target}`, `qtApp: { connect: ${codeLiteral(target)} }`);
  }

  async attachTo(pid: number): Promise<QtApp> {
    await this.close();
    return this.adopt(attach(pid, { gammaray: this.options.gammaray, defaultTimeout: this.timeout }), `attached to pid ${pid}`);
  }

  /** Closes the application (terminates it if it was launched). Returns what was closed. */
  async close(): Promise<string | undefined> {
    const app = this.current;
    if (!app) return undefined;
    const description = this.description;
    this.current = undefined;
    this.spies.clear();
    await app.close().catch(() => undefined);
    this.video = undefined;
    return description;
  }

  /** The playwright.config.ts `use` entry for running generated tests, if known. */
  get fixtureConfig(): string | undefined {
    return this.fixture;
  }

  status(): string {
    const app = this.current;
    if (!app) return `No application is connected${this.lastExit ? ` (${this.lastExit})` : ''}.`;
    const i = app.info;
    return `${i.appName || 'application'} (pid ${i.pid}, Qt ${i.qtVersion}, platform ${i.platform}), ${this.description}`;
  }

  /** Application output that has not been reported yet. */
  takeNewOutput(): string {
    const output = this.current?.output() ?? '';
    const fresh = newOutput(this.seenOutput, output);
    this.seenOutput = output;
    return fresh;
  }

  /** A locator for a tool's target: a snapshot ref or a locator expression / selector. */
  async target(params: { ref?: string; locator?: string; element?: string }, what = 'target'): Promise<{ locator: Locator; code: string }> {
    const app = await this.ensureApp();
    if (params.ref) {
      const handle = handleForRef(params.ref);
      if (handle === undefined) throw new ToolError(`"${params.ref}" is not a ref: use the [ref=...] value of an element in the snapshot, e.g. e42.`);
      let code = `app.locator('handle=${handle}')`;
      try {
        // a stable locator for the generated test, chosen like codegen does
        code = (await app.connection.call<{ code: string }>('locatorFor', { handle })).code;
      } catch (e) {
        if (e instanceof QtError && e.code === ErrorCode.StaleHandle)
          throw new ToolError(`Ref ${params.ref} no longer exists (the element was destroyed). Take a new snapshot with qt_snapshot.`);
      }
      const label = params.element ? `${params.element} [ref=${refForHandle(handle)}]` : `ref=${refForHandle(handle)}`;
      return { locator: app.locator(`handle=${handle}`).describe(label), code };
    }
    if (params.locator) {
      const locator = parseLocator(app, params.locator);
      return { locator: params.element ? locator.describe(params.element) : locator, code: `app.${locator.expression}` };
    }
    throw new ToolError(`The ${what} is missing: pass "ref" (from qt_snapshot) or "locator" (e.g. "getByRole('button', { name: 'OK' })").`);
  }

  /**
   * ARIA snapshot of all windows with refs, long lists shortened; or all of @p root.
   */
  async snapshot(root?: Locator): Promise<string> {
    const app = await this.ensureApp();
    const params: Record<string, unknown> = { refs: true };
    if (root) params.handle = await root.handle();
    const r = await app.connection.call<{ nodes: AriaNode[] }>('ariaSnapshot', params);
    let yaml = renderAriaSnapshot(r.nodes, {
      refs: true,
      // e.g. item views with many rows; qt_snapshot of the element lists all of them
      maxChildren: root ? undefined : MAX_CHILDREN,
      omitted: (parent, count) =>
        `... ${count} more${parent.handle !== undefined ? `: qt_snapshot with ref ${refForHandle(parent.handle)} lists all` : ''}`,
    });
    if (!yaml) yaml = '# no accessible elements (no visible windows?); try qt_screenshot';
    const max = this.options.maxSnapshotLength ?? 40_000;
    if (yaml.length > max) {
      const cut = yaml.lastIndexOf('\n', max);
      yaml = `${yaml.slice(0, cut > 0 ? cut : max)}\n# ... truncated (${yaml.length} characters): pass a ref or locator to qt_snapshot to see a part`;
    }
    return yaml;
  }

  /** Waits until delivered input has been processed and the UI stopped changing; returns the snapshot. */
  async settledSnapshot(): Promise<string> {
    const app = await this.ensureApp();
    await app.sync();
    let previous = await this.snapshot();
    for (let i = 0; i < 10; ++i) {
      await sleep(100);
      const current = await this.snapshot();
      if (current === previous) return current;
      previous = current;
    }
    return previous;
  }

  addSpy(spy: SignalSpy): string {
    const id = `s${this.nextSpy++}`;
    this.spies.set(id, spy);
    return id;
  }

  spy(id: string): SignalSpy {
    const spy = this.spies.get(id);
    if (!spy) throw new ToolError(`Unknown spy "${id}" (spies end when the application is closed).`);
    return spy;
  }

  get recordingVideo(): Video | undefined {
    return this.video;
  }

  set recordingVideo(v: Video | undefined) {
    this.video = v;
  }

  /** Resolves @p path (relative to the output directory) and makes sure it stays inside it. */
  async outputPath(path: string | undefined, fallback: string): Promise<string> {
    const p = resolvePath(this.outputDir, path ?? fallback);
    const rel = relative(this.outputDir, p);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new ToolError(`Files can only be written below the output directory ${this.outputDir}.`);
    await mkdir(dirname(p), { recursive: true });
    return p;
  }
}

const targetShape = {
  element: z.string().optional().describe('Human-readable description of the element, e.g. "Login button" (used in messages)'),
  ref: z.string().optional().describe('Exact ref of the element from the snapshot, e.g. "e42"'),
  locator: z
    .string()
    .optional()
    .describe(`Instead of a ref: a qt-playwright locator expression such as "getByRole('button', { name: 'Login' })" or "locator('#loginBox').getByLabel('User:')", or a selector such as "#okButton"`),
};

const modifiersSchema = z
  .array(z.enum(['Shift', 'Control', 'Alt', 'Meta', 'ControlOrMeta']))
  .optional()
  .describe('Modifier keys held during the action');

/** Creates an MCP server whose tools work on @p context (one per MCP session; contexts can be shared). */
export function createMcpServer(context: McpContext = new McpContext()): McpServer {
  const server = new McpServer(
    { name: 'qt-playwright', version: VERSION },
    {
      instructions: [
        'Drives a Qt (Widgets / Qt Quick) application through GammaRay, like Playwright MCP drives a browser.',
        'Start with qt_launch (or qt_connect / qt_attach) unless an application is configured, then qt_snapshot.',
        'Snapshots list the accessibility tree of all windows; act on elements by their [ref=...] value',
        '(e.g. ref "e42") or by a qt-playwright locator expression (getByTestId matches the objectName). Actions wait for the element to be',
        'visible, enabled and stable, and return a fresh snapshot. Use qt_expect for checks, qt_screenshot',
        'to see the windows, and qt_generate_test to turn the actions and checks into a qt-playwright test.',
      ].join(' '),
    },
  );

  /** Runs a tool body; errors become tool errors with the message for the agent. */
  const run = async (body: () => Promise<Content>, waitMs = 0): Promise<ToolResult> => {
    // a blocked GUI thread never answers: don't let that hang the agent
    const limit = context.timeout + waitMs + 60_000;
    let timer: NodeJS.Timeout | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ToolError(`The application did not respond within ${Math.round(limit / 1000)} s (is its GUI thread blocked?).`)),
        limit,
      );
    });
    try {
      return { content: await Promise.race([body(), watchdog]) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const content: Content = [text(message)];
      const output = context.app ? context.takeNewOutput() : '';
      if (output.trim()) content.push(text(`### New application output\n${output.slice(-4000)}`));
      return { content, isError: true };
    } finally {
      clearTimeout(timer);
    }
  };

  /** invoke() and evaluate() return only when the call does: e.g. after a dialog's exec() ends. */
  const synchronousCall = async <T>(call: Promise<T>, what: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ToolError(
              `${what} has not returned after ${context.timeout} ms. If it opened a modal dialog (exec()), it returns once the dialog closes; the application stays usable meanwhile: take a snapshot.`,
            ),
          ),
        context.timeout,
      );
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Result of an action: the code that reproduces it, then the new state of the application. */
  const actionResult = async (code: string | undefined, extra: string[] = []): Promise<Content> => {
    if (code) context.code.push(code);
    const parts: string[] = [];
    if (code) parts.push(`### Ran qt-playwright code\n\`\`\`ts\n${code}\n\`\`\``);
    parts.push(...extra);
    if (context.options.snapshotAfterAction !== false && context.app) {
      try {
        const snapshot = await context.settledSnapshot();
        if (snapshot === context.lastSnapshot) parts.push('### Snapshot\nunchanged');
        else parts.push(`### Snapshot\n\`\`\`yaml\n${snapshot}\n\`\`\``);
        context.lastSnapshot = snapshot;
      } catch (e) {
        parts.push(`### Snapshot\nnot available: ${(e as Error).message}`);
      }
    } else if (context.app) {
      await context.app.sync().catch(() => undefined);
    }
    const output = context.takeNewOutput();
    if (output.trim()) parts.push(`### New application output\n\`\`\`\n${output.slice(-4000)}\n\`\`\``);
    return [text(parts.join('\n\n'))];
  };

  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const acting = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  // --- session -------------------------------------------------------------------------

  server.registerTool(
    'qt_launch',
    {
      title: 'Launch application',
      description:
        'Starts a Qt application under GammaRay and connects to it (closing the current one). With "remote" (or the --remote option) it is started on another machine by a `qt-playwright server`.',
      inputSchema: {
        executable: z.string().optional().describe('Path of the executable (default: the first --app of the server)'),
        args: z.array(z.string()).optional().describe('Command line arguments'),
        env: z.record(z.string(), z.string()).optional().describe('Extra environment variables'),
        cwd: z.string().optional().describe('Working directory'),
        headless: z.boolean().optional().describe('Run without a display (QT_QPA_PLATFORM=offscreen)'),
        remote: z.string().optional().describe('ws://host:port of a `qt-playwright server` to launch on (default: --remote)'),
        token: z.string().optional().describe('Token of that server (default: --token / $QTPW_SERVER_TOKEN)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ executable, args, env, cwd, headless, remote, token }) =>
      run(async () => {
        const exe = executable ?? context.options.apps?.[0];
        if (!exe) throw new ToolError('Pass "executable" (the server has no default application, see --app).');
        const extra: Partial<LaunchOptions> = {};
        if (env) extra.env = { ...context.options.env, ...env };
        if (cwd) extra.cwd = cwd;
        if (headless !== undefined) extra.headless = headless;
        if (remote) extra.remote = { url: remote, token };
        else if (token && context.options.remote)
          extra.remote = { url: typeof context.options.remote === 'string' ? context.options.remote : context.options.remote.url, token };
        await context.launch(exe, args ?? (executable ? [] : (context.options.args ?? [])), extra);
        context.code.length = 0;
        return actionResult(undefined, [`### Application\n${context.status()}`]);
      }, 60_000),
  );

  server.registerTool(
    'qt_connect',
    {
      title: 'Connect to application',
      description:
        'Connects to an application that already runs the GammaRay automation server, e.g. on a device started with GAMMARAY_AUTOMATION_PORT=<port> GAMMARAY_AUTOMATION_ADDRESS=0.0.0.0 gammaray --inject-only <app>. Closing only disconnects.',
      inputSchema: { target: z.string().describe('"host:port" or "ws://host:port" of the automation server') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ target }) =>
      run(async () => {
        await context.connectTo(target);
        context.code.length = 0;
        return actionResult(undefined, [`### Application\n${context.status()}`]);
      }),
  );

  server.registerTool(
    'qt_attach',
    {
      title: 'Attach to process',
      description: 'Injects GammaRay into a running Qt process on this machine (needs gdb or lldb) and connects to it. Closing only disconnects.',
      inputSchema: { pid: z.number().int().positive().describe('Process id') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ pid }) =>
      run(async () => {
        await context.attachTo(pid);
        context.code.length = 0;
        return actionResult(undefined, [`### Application\n${context.status()}`]);
      }, 60_000),
  );

  server.registerTool(
    'qt_close',
    {
      title: 'Close application',
      description: 'Disconnects from the application; terminates it if it was launched by qt_launch.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        await context.recordingVideo?.stop().catch(() => undefined);
        const closed = await context.close();
        return [text(closed ? `Closed (${closed}).` : 'No application was connected.')];
      }),
  );

  server.registerTool(
    'qt_status',
    {
      title: 'Application status',
      description: 'Shows the connected application, its windows, and its recent output (stdout/stderr, e.g. qDebug messages).',
      inputSchema: { outputLines: z.number().int().min(0).optional().describe('Number of output lines to show (default 50)') },
      annotations: readOnly,
    },
    ({ outputLines }) =>
      run(async () => {
        const parts = [`### Application\n${context.status()}`];
        const app = context.app;
        if (app?.isRunning()) {
          const windows = await app.windows();
          parts.push(
            `### Windows\n${windows.map((w) => `- ${JSON.stringify(w.text ?? '')} (${w.type}${w.objectName ? ` #${w.objectName}` : ''}) [ref=${refForHandle(w.handle)}]`).join('\n') || 'none'}`,
          );
          const lines = app.output().split('\n');
          const n = outputLines ?? 50;
          if (n > 0) parts.push(`### Output (last ${n} lines)\n\`\`\`\n${lines.slice(-n).join('\n')}\n\`\`\``);
          context.takeNewOutput();
        }
        parts.push(`### Recorded\n${context.code.length} action(s)/assertion(s) for qt_generate_test; output directory ${context.outputDir}`);
        return [text(parts.join('\n\n'))];
      }),
  );

  // --- observation -----------------------------------------------------------------------

  server.registerTool(
    'qt_snapshot',
    {
      title: 'Accessibility snapshot',
      description:
        'Accessibility snapshot of all windows as YAML: role, name, value and state of every element, with a [ref=...] to act on it. Better than a screenshot for finding elements. Elements with more than 20 children (long lists) are shortened; pass the ref or a locator of an element to get all of it.',
      inputSchema: { ...targetShape },
      annotations: readOnly,
    },
    (params) =>
      run(async () => {
        const root = params.ref || params.locator ? (await context.target(params)).locator : undefined;
        if (!root) await (await context.ensureApp()).sync();
        const snapshot = await context.snapshot(root);
        if (!root) context.lastSnapshot = snapshot;
        return [text(`### Application\n${context.status()}\n\n### Snapshot\n\`\`\`yaml\n${snapshot}\n\`\`\``)];
      }),
  );

  server.registerTool(
    'qt_screenshot',
    {
      title: 'Screenshot',
      description:
        'Takes a screenshot of all windows composed (the default, with title bars), or of one element. Returns the image and optionally saves it in the output directory.',
      inputSchema: {
        ...targetShape,
        path: z.string().optional().describe('Also save the image under this name in the output directory'),
        format: z.enum(['png', 'jpeg']).optional().describe('Image format for all windows (default png)'),
        scale: z.number().min(0.1).max(2).optional().describe('Scale factor for all windows (default 1)'),
      },
      annotations: readOnly,
    },
    (params) =>
      run(async () => {
        const app = await context.ensureApp();
        let data: Buffer;
        let mimeType = 'image/png';
        let note: string;
        if (params.ref || params.locator) {
          const { locator } = await context.target(params);
          data = await locator.screenshot();
          note = `Screenshot of ${locator}`;
        } else {
          const r = await app.connection.call<{ image: string; format: string; canvas: { x: number; y: number }; width: number; height: number }>(
            'screenshotAll',
            { format: params.format ?? 'png', quality: 85, scale: params.scale ?? 1, cursor: true },
          );
          data = Buffer.from(r.image, 'base64');
          mimeType = r.format === 'jpeg' ? 'image/jpeg' : 'image/png';
          note = `Screenshot of all windows (${r.width}x${r.height}); image pixel (0, 0) is screen position (${r.canvas.x}, ${r.canvas.y})${(params.scale ?? 1) !== 1 ? `, scale ${params.scale}` : ''}`;
        }
        if (params.path) {
          const file = await context.outputPath(params.path, 'screenshot.png');
          await writeFile(file, data);
          note += `, saved to ${file}`;
        }
        return [text(note), { type: 'image', data: data.toString('base64'), mimeType }];
      }),
  );

  server.registerTool(
    'qt_find',
    {
      title: 'Find elements',
      description:
        'Lists the elements a locator expression or selector currently matches (without waiting), with their refs. Use it to try locators: actions need exactly one match.',
      inputSchema: {
        locator: z.string().describe(`Locator expression ("getByRole('button')", "locator('#form').getByText('Save')") or selector ("QPushButton")`),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum number of matches to describe (default 20)'),
      },
      annotations: readOnly,
    },
    ({ locator: expression, limit }) =>
      run(async () => {
        const app = await context.ensureApp();
        const locator = parseLocator(app, expression);
        const elements = await locator.elements();
        const lines: string[] = [];
        for (const e of elements.slice(0, limit ?? 20)) {
          try {
            const i = await app.connection.call<any>('describe', { handle: e.handle });
            const attrs = [
              i.role && `role ${i.role}`,
              i.accessibleName && `name ${JSON.stringify(i.accessibleName)}`,
              i.text && `text ${JSON.stringify(i.text)}`,
              i.objectName && `objectName ${i.objectName}`,
              i.id && `id ${i.id}`,
              i.visible ? 'visible' : 'hidden',
              i.enabled ? undefined : 'disabled',
            ].filter(Boolean);
            lines.push(`- ${i.type} [ref=${refForHandle(e.handle)}]: ${attrs.join(', ')}`);
          } catch {
            lines.push(`- ${e.type} [ref=${refForHandle(e.handle)}] (gone)`);
          }
        }
        if (elements.length > lines.length) lines.push(`- ... ${elements.length - lines.length} more`);
        return [text(`${locator.expression} matches ${elements.length} element(s)${elements.length > 1 ? ' (actions need exactly one: refine it, or use .first() / .nth(i))' : ''}\n${lines.join('\n')}`)];
      }),
  );

  server.registerTool(
    'qt_inspect',
    {
      title: 'Inspect element',
      description:
        'Details of one element: C++/QML types, objectName, QML id, role, accessible name, geometry, state, the locator a test should use, and its Qt properties.',
      inputSchema: {
        ...targetShape,
        properties: z.boolean().optional().describe('Include all Qt properties (default true)'),
      },
      annotations: readOnly,
    },
    (params) =>
      run(async () => {
        const app = await context.ensureApp();
        const { locator } = await context.target(params);
        const handle = await locator.handle();
        const info = await app.connection.call('describe', { handle });
        // the locator codegen would choose: role + name, label, test id...
        const suggested = await app.connection.call<{ code: string }>('locatorFor', { handle });
        const parts = [`### Element ${refForHandle(handle)}\n\`\`\`json\n${JSON.stringify(info, null, 2)}\n\`\`\``, `### Locator\n\`${suggested.code}\``];
        if (params.properties !== false) {
          const props = await locator.getProperties();
          let json = JSON.stringify(props, null, 1);
          if (json.length > 20_000) json = `${json.slice(0, 20_000)}\n... truncated`;
          parts.push(`### Properties\n\`\`\`json\n${json}\n\`\`\``);
        }
        return [text(parts.join('\n\n'))];
      }),
  );

  // --- actions ---------------------------------------------------------------------------

  server.registerTool(
    'qt_click',
    {
      title: 'Click',
      description: 'Clicks an element with real mouse input, after waiting until it is visible, enabled, stable and not covered.',
      inputSchema: {
        ...targetShape,
        button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)'),
        doubleClick: z.boolean().optional().describe('Double-click instead'),
        modifiers: modifiersSchema,
        position: z.object({ x: z.number(), y: z.number() }).optional().describe('Point relative to the element top-left (default: center)'),
      },
      annotations: acting,
    },
    (params) =>
      run(async () => {
        const { locator, code } = await context.target(params);
        const options: { button?: MouseButton; modifiers?: Modifier[]; position?: { x: number; y: number } } = {};
        if (params.button && params.button !== 'left') options.button = params.button;
        if (params.modifiers?.length) options.modifiers = params.modifiers;
        if (params.position) options.position = params.position;
        const args = Object.keys(options).length ? codeLiteral(options) : '';
        if (params.doubleClick) await locator.dblclick(options);
        else await locator.click(options);
        return actionResult(`await ${code}.${params.doubleClick ? 'dblclick' : 'click'}(${args});`);
      }),
  );

  server.registerTool(
    'qt_hover',
    {
      title: 'Hover',
      description: 'Moves the mouse over an element (shows tooltips, hover effects).',
      inputSchema: { ...targetShape },
      annotations: acting,
    },
    (params) =>
      run(async () => {
        const { locator, code } = await context.target(params);
        await locator.hover();
        return actionResult(`await ${code}.hover();`);
      }),
  );

  server.registerTool(
    'qt_type',
    {
      title: 'Type text',
      description:
        'Types text into an editable element, replacing its content (like fill; with "slowly", key by key without clearing). Without a target, types into the focused element.',
      inputSchema: {
        ...targetShape,
        text: z.string().describe('Text to type'),
        submit: z.boolean().optional().describe('Press Enter afterwards'),
        slowly: z.boolean().optional().describe('Type one character at a time (triggers per-key handlers) instead of replacing the text'),
      },
      annotations: acting,
    },
    (params) =>
      run(async () => {
        const lines: string[] = [];
        if (params.ref || params.locator) {
          const { locator, code } = await context.target(params);
          if (params.slowly) {
            await locator.pressSequentially(params.text);
            lines.push(`await ${code}.pressSequentially(${codeLiteral(params.text)});`);
          } else {
            await locator.fill(params.text);
            lines.push(`await ${code}.fill(${codeLiteral(params.text)});`);
          }
          if (params.submit) {
            await locator.press('Enter');
            lines.push(`await ${code}.press('Enter');`);
          }
        } else {
          const app = await context.ensureApp();
          await app.type(params.text);
          lines.push(`await app.type(${codeLiteral(params.text)});`);
          if (params.submit) {
            await app.press('Enter');
            lines.push(`await app.press('Enter');`);
          }
        }
        return actionResult(lines.join('\n'));
      }),
  );

  server.registerTool(
    'qt_press_key',
    {
      title: 'Press key',
      description:
        'Presses a key or shortcut, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+A", "F2", "a". On an element (focused first) or the focused window.',
      inputSchema: { ...targetShape, key: z.string().describe('Key in Playwright notation, e.g. "Control+Shift+Z"') },
      annotations: acting,
    },
    (params) =>
      run(async () => {
        if (params.ref || params.locator) {
          const { locator, code } = await context.target(params);
          await locator.press(params.key);
          return actionResult(`await ${code}.press(${codeLiteral(params.key)});`);
        }
        const app = await context.ensureApp();
        await app.press(params.key);
        return actionResult(`await app.press(${codeLiteral(params.key)});`);
      }),
  );

  server.registerTool(
    'qt_select_option',
    {
      title: 'Select option',
      description: 'Selects options in a combo box (by label or value) or rows of a list/table view, through the UI like a user.',
      inputSchema: { ...targetShape, values: z.array(z.string()).min(1).describe('Labels or values to select') },
      annotations: acting,
    },
    (params) =>
      run(async () => {
        const { locator, code } = await context.target(params);
        const selected = await locator.selectOption(params.values.length === 1 ? params.values[0] : params.values);
        const arg = params.values.length === 1 ? codeLiteral(params.values[0]) : codeLiteral(params.values);
        return actionResult(`await ${code}.selectOption(${arg});`, [`Selected: ${JSON.stringify(selected)}`]);
      }),
  );

  server.registerTool(
    'qt_check',
    {
      title: 'Check / uncheck',
      description: 'Checks or unchecks a check box, radio button, checkable button or item view row (clicks only if needed).',
      inputSchema: { ...targetShape, checked: z.boolean().optional().describe('Desired state (default true)') },
      annotations: acting,
    },
    (params) =>
      run(async () => {
        const { locator, code } = await context.target(params);
        const checked = params.checked ?? true;
        await locator.setChecked(checked);
        return actionResult(`await ${code}.${checked ? 'check' : 'uncheck'}();`);
      }),
  );

  server.registerTool(
    'qt_drag',
    {
      title: 'Drag and drop',
      description: 'Drags one element onto another with real mouse input (press, moves, release).',
      inputSchema: {
        startElement: z.string().optional().describe('Description of the element to drag'),
        startRef: z.string().optional().describe('Ref of the element to drag'),
        startLocator: z.string().optional().describe('Locator of the element to drag (instead of startRef)'),
        endElement: z.string().optional().describe('Description of the drop target'),
        endRef: z.string().optional().describe('Ref of the drop target'),
        endLocator: z.string().optional().describe('Locator of the drop target (instead of endRef)'),
      },
      annotations: acting,
    },
    (params) =>
      run(async () => {
        const source = await context.target({ element: params.startElement, ref: params.startRef, locator: params.startLocator }, 'element to drag');
        const target = await context.target({ element: params.endElement, ref: params.endRef, locator: params.endLocator }, 'drop target');
        await source.locator.dragTo(target.locator);
        return actionResult(`await ${source.code}.dragTo(${target.code});`);
      }),
  );

  server.registerTool(
    'qt_scroll',
    {
      title: 'Scroll',
      description: 'Scrolls with the mouse wheel over an element (120 = one wheel notch; positive deltaY scrolls down).',
      inputSchema: {
        ...targetShape,
        deltaX: z.number().optional().describe('Horizontal delta (positive: right)'),
        deltaY: z.number().optional().describe('Vertical delta (positive: down, default 360)'),
      },
      annotations: acting,
    },
    (params) =>
      run(async () => {
        const { locator, code } = await context.target(params);
        const options = { deltaX: params.deltaX, deltaY: params.deltaX === undefined && params.deltaY === undefined ? 360 : params.deltaY };
        await locator.scroll(options);
        return actionResult(`await ${code}.scroll(${codeLiteral(options)});`);
      }),
  );

  server.registerTool(
    'qt_mouse_click_xy',
    {
      title: 'Click at coordinates',
      description:
        'Clicks at a screen position, for content without elements (custom painting, QGraphicsView). qt_screenshot tells which screen position its top-left pixel is.',
      inputSchema: {
        x: z.number().describe('Screen x'),
        y: z.number().describe('Screen y'),
        button: z.enum(['left', 'right', 'middle']).optional(),
        clickCount: z.number().int().min(1).max(3).optional().describe('2 for a double click'),
      },
      annotations: acting,
    },
    (params) =>
      run(async () => {
        const app = await context.ensureApp();
        const options: { button?: MouseButton; clickCount?: number } = {};
        if (params.button && params.button !== 'left') options.button = params.button;
        if (params.clickCount && params.clickCount > 1) options.clickCount = params.clickCount;
        await app.mouse.click(params.x, params.y, options);
        const args = Object.keys(options).length ? `, ${codeLiteral(options)}` : '';
        return actionResult(`await app.mouse.click(${params.x}, ${params.y}${args});`);
      }),
  );

  server.registerTool(
    'qt_handle_dialog',
    {
      title: 'Handle dialog',
      description:
        'Accepts or dismisses the dialog that is shown (QDialog, QMessageBox, QInputDialog, Qt Quick Dialog): Enter/Escape for widget dialogs, accept()/reject() for Qt Quick ones. Buttons of a dialog can also be clicked by ref.',
      inputSchema: {
        accept: z.boolean().describe('Accept (true) or dismiss (false)'),
        promptText: z.string().optional().describe('Text to enter first, e.g. into a QInputDialog'),
      },
      annotations: acting,
    },
    (params) =>
      run(async () => {
        const app = await context.ensureApp();
        const dialog = await app.waitForDialog({ timeout: Math.min(context.timeout, 2_000) }).catch(() => {
          throw new ToolError('No dialog is shown.');
        });
        const lines = ['const dialog = await app.waitForDialog();'];
        const info = [`Dialog: ${JSON.stringify(await dialog.title())}, message ${JSON.stringify(await dialog.message().catch(() => ''))}`];
        if (params.promptText !== undefined) {
          await dialog.locator.getByRole('textbox').first().fill(params.promptText);
          lines.push(`await dialog.locator.getByRole('textbox').first().fill(${codeLiteral(params.promptText)});`);
        }
        if (params.accept) await dialog.accept();
        else await dialog.dismiss();
        lines.push(`await dialog.${params.accept ? 'accept' : 'dismiss'}();`);
        return actionResult(`{\n  ${lines.join('\n  ')}\n}`, info);
      }),
  );

  server.registerTool(
    'qt_file_upload',
    {
      title: 'Choose files',
      description:
        'Chooses files in a file dialog: either clicks the given element (a button that opens a QFileDialog / FileDialog) first, or uses the file dialog that is already shown. Paths refer to the machine of the application.',
      inputSchema: { ...targetShape, paths: z.array(z.string()).min(1).describe('Absolute file paths') },
      annotations: acting,
    },
    (params) =>
      run(async () => {
        const files = params.paths.length === 1 ? codeLiteral(params.paths[0]) : codeLiteral(params.paths);
        if (params.ref || params.locator) {
          const { locator, code } = await context.target(params);
          await locator.setInputFiles(params.paths);
          return actionResult(`await ${code}.setInputFiles(${files});`);
        }
        const app = await context.ensureApp();
        const chooser = await app.waitForFileChooser({ timeout: Math.min(context.timeout, 2_000) }).catch(() => {
          throw new ToolError('No file dialog is shown: pass the element that opens it.');
        });
        await chooser.setFiles(params.paths);
        return actionResult(`await (await app.waitForFileChooser()).setFiles(${files});`);
      }),
  );

  server.registerTool(
    'qt_set_property',
    {
      title: 'Set property',
      description: 'Writes a Qt property of an element (enums by key name, colors as "#rrggbb", geometry as {x, y, width, height}).',
      inputSchema: { ...targetShape, name: z.string().describe('Property name'), value: z.any().describe('New value (JSON)') },
      annotations: acting,
    },
    (params) =>
      run(async () => {
        const { locator, code } = await context.target(params);
        await locator.setProperty(params.name, params.value);
        return actionResult(`await ${code}.setProperty(${codeLiteral(params.name)}, ${codeLiteral(params.value)});`);
      }),
  );

  server.registerTool(
    'qt_invoke_method',
    {
      title: 'Invoke method',
      description: 'Calls a slot, Q_INVOKABLE or QML function of an element and returns its result. Pass {"handle": N} for QObject arguments.',
      inputSchema: { ...targetShape, method: z.string().describe('Method name'), args: z.array(z.any()).optional().describe('Arguments (JSON)') },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (params) =>
      run(async () => {
        const { locator, code } = await context.target(params);
        const args = params.args ?? [];
        const result = await synchronousCall(locator.invoke(params.method, ...args), `${params.method}()`);
        return actionResult(`await ${code}.invoke(${[params.method, ...args].map(codeLiteral).join(', ')});`, [`Result: ${JSON.stringify(result) ?? 'undefined'}`]);
      }),
  );

  server.registerTool(
    'qt_evaluate',
    {
      title: 'Evaluate JavaScript',
      description:
        'Runs a JavaScript function inside the application with Qt\'s JavaScript engine and returns the JSON result: "(el) => el.text" on an element (a QObject wrapper with properties, slots and signals), or "() => qApp.applicationName" without a target. No DOM.',
      inputSchema: { ...targetShape, function: z.string().describe('Function source, e.g. "(el) => el.count"') },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (params) =>
      run(async () => {
        let result: unknown;
        if (params.ref || params.locator) result = await synchronousCall((await context.target(params)).locator.evaluate(params.function), 'The function');
        else result = await synchronousCall((await context.ensureApp()).evaluate(params.function), 'The function');
        return [text(`Result: ${JSON.stringify(result, null, 1) ?? 'undefined'}`)];
      }),
  );

  // --- waiting and checking --------------------------------------------------------------

  server.registerTool(
    'qt_wait_for',
    {
      title: 'Wait',
      description:
        'Waits until a text appears or disappears, an element reaches a state, or a number of seconds has passed. Returns a fresh snapshot.',
      inputSchema: {
        text: z.string().optional().describe('Wait until an element with this text (case-insensitive substring) is visible'),
        textGone: z.string().optional().describe('Wait until no visible element has this text'),
        ...targetShape,
        state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional().describe('State for ref/locator (default visible)'),
        time: z.number().min(0).max(60).optional().describe('Seconds to wait'),
        timeout: z.number().int().min(0).optional().describe('Timeout in ms (default: the server timeout)'),
      },
      annotations: readOnly,
    },
    (params) =>
      run(async () => {
        const app = await context.ensureApp();
        const timeout = params.timeout ?? context.timeout;
        const lines: string[] = [];
        if (params.time) await sleep(params.time * 1000);
        if (params.text !== undefined) {
          const l = app.getByText(params.text).visible().first();
          await expect(l).toBeVisible({ timeout });
          lines.push(`await expect(app.${l.expression}).toBeVisible();`);
        }
        if (params.textGone !== undefined) {
          const l = app.getByText(params.textGone).visible();
          await expect(l).toHaveCount(0, { timeout });
          lines.push(`await expect(app.${l.expression}).toHaveCount(0);`);
        }
        if (params.ref || params.locator) {
          const { locator, code } = await context.target(params);
          const state = params.state ?? 'visible';
          await locator.waitFor({ state, timeout });
          lines.push(`await ${code}.waitFor({ state: '${state}' });`);
        }
        if (!lines.length && !params.time) throw new ToolError('Pass text, textGone, a ref/locator (with state) or time.');
        return actionResult(lines.join('\n') || undefined);
      }, (params.timeout ?? context.timeout) * 3 + (params.time ?? 0) * 1000),
  );

  const matcherNames = [...new Set([...Object.keys(LOCATOR_MATCHERS), ...Object.keys(APP_MATCHERS)])] as [string, ...string[]];
  server.registerTool(
    'qt_expect',
    {
      title: 'Assert',
      description: [
        'Checks the application with a retrying qt-playwright assertion (waits up to the timeout until it passes), for live testing.',
        'With a ref/locator: toBeVisible, toBeHidden, toBeEnabled, toBeDisabled, toBeEditable, toBeChecked, toBeAttached, toBeFocused, toBeEmpty, toBeInViewport (no expected value);',
        'toHaveText, toContainText, toHaveValue, toHaveValues, toHaveAccessibleName, toHaveAccessibleDescription, toHaveId, toHaveClass, toHaveRole, toHaveCount, toMatchAriaSnapshot (expected);',
        'toHaveProperty, toHaveAttribute, toHaveCSS (name and expected).',
        'Without a target: toHaveTitle, toMatchAriaSnapshot for the whole application.',
        'Strings written as "/pattern/flags" are regular expressions (for text matchers). Passing assertions are added to the generated test.',
      ].join(' '),
      inputSchema: {
        ...targetShape,
        assertion: z.enum(matcherNames).describe('Assertion name, e.g. "toHaveText"'),
        expected: z.any().optional().describe('Expected value (string, number, boolean, array, object)'),
        name: z.string().optional().describe('Property / attribute / CSS name for toHaveProperty, toHaveAttribute, toHaveCSS'),
        not: z.boolean().optional().describe('Negate the assertion'),
        timeout: z.number().int().min(0).optional().describe('Timeout in ms (default: the server timeout)'),
      },
      annotations: readOnly,
    },
    (params) =>
      run(async () => {
        const app = await context.ensureApp();
        const hasTarget = !!(params.ref || params.locator);
        const kind = (hasTarget ? LOCATOR_MATCHERS : APP_MATCHERS)[params.assertion as never] as string | undefined;
        if (!kind)
          throw new ToolError(
            hasTarget ? `${params.assertion} needs no target (it checks the whole application).` : `${params.assertion} needs a ref or locator.`,
          );
        const target = hasTarget ? await context.target(params) : { locator: undefined, code: 'app' };
        const args: unknown[] = [];
        if (kind === 'text' || kind === 'value') {
          if (params.expected === undefined) throw new ToolError(`${params.assertion} needs "expected".`);
          args.push(kind === 'text' ? toMatcher(params.expected) : params.expected);
        } else if (kind === 'named' || kind === 'namedText') {
          if (!params.name) throw new ToolError(`${params.assertion} needs "name".`);
          args.push(params.name);
          if (params.expected !== undefined || kind === 'named') args.push(kind === 'namedText' ? toMatcher(params.expected) : params.expected);
        }
        const assertions: any = target.locator ? expect(target.locator) : expect(app);
        const subject = params.not ? assertions.not : assertions;
        try {
          await subject[params.assertion](...args, { timeout: params.timeout ?? context.timeout });
        } catch (e) {
          throw new ToolError(`Assertion failed: ${(e as Error).message}`);
        }
        const code = `await expect(${target.code})${params.not ? '.not' : ''}.${params.assertion}(${args.map(codeLiteral).join(', ')});`;
        context.code.push(code);
        return [text(`Passed.\n\`\`\`ts\n${code}\n\`\`\``)];
      }, params.timeout ?? 0),
  );

  server.registerTool(
    'qt_spy_signal',
    {
      title: 'Spy on a signal',
      description:
        'Starts recording emissions of a Qt signal of an element (like QSignalSpy), e.g. "clicked", "textChanged" or "loggedIn(QString)". Read them with qt_signal_emissions.',
      inputSchema: { ...targetShape, signal: z.string().describe('Signal name or signature') },
      annotations: readOnly,
    },
    (params) =>
      run(async () => {
        const { locator } = await context.target(params);
        const spy = await locator.spy(params.signal);
        return [text(`Spy ${context.addSpy(spy)} records ${spy}.`)];
      }),
  );

  server.registerTool(
    'qt_signal_emissions',
    {
      title: 'Signal emissions',
      description: 'Arguments of every emission a spy recorded; optionally waits until there are at least "count" emissions.',
      inputSchema: {
        spy: z.string().describe('Spy id from qt_spy_signal, e.g. "s1"'),
        count: z.number().int().min(1).optional().describe('Wait until this many emissions were recorded'),
        timeout: z.number().int().min(0).optional(),
      },
      annotations: readOnly,
    },
    (params) =>
      run(async () => {
        const spy = context.spy(params.spy);
        const deadline = Date.now() + (params.timeout ?? context.timeout);
        let emissions = await spy.emissions();
        while (params.count && emissions.length < params.count && Date.now() < deadline) {
          await sleep(50);
          emissions = await spy.emissions();
        }
        const shortfall = params.count && emissions.length < params.count ? ` (expected at least ${params.count})` : '';
        const message = `${emissions.length} emission(s)${shortfall}:\n${JSON.stringify(emissions)}`;
        if (shortfall) throw new ToolError(message);
        return [text(message)];
      }, params.timeout ?? 0),
  );

  // --- highlight, tracing, video, code ---------------------------------------------------

  server.registerTool(
    'qt_highlight',
    {
      title: 'Highlight',
      description: 'Draws a highlight over an element inside the application, e.g. to show a watching user something. Without a target, removes it.',
      inputSchema: { ...targetShape },
      annotations: readOnly,
    },
    (params) =>
      run(async () => {
        if (!params.ref && !params.locator) {
          await (await context.ensureApp()).hideHighlight();
          return [text('Highlight removed.')];
        }
        const { locator } = await context.target(params);
        await locator.highlight();
        return [text(`Highlighted ${locator}.`)];
      }),
  );

  server.registerTool(
    'qt_start_tracing',
    {
      title: 'Start tracing',
      description: "Starts recording a trace (Playwright's trace.zip format: actions, screenshots, snapshots, output) of what is done from now on.",
      inputSchema: { title: z.string().optional() },
      annotations: readOnly,
    },
    ({ title }) =>
      run(async () => {
        const app = await context.ensureApp();
        await app.tracing.start({ title });
        return [text('Tracing started; stop it with qt_stop_tracing.')];
      }),
  );

  server.registerTool(
    'qt_stop_tracing',
    {
      title: 'Stop tracing',
      description: 'Stops tracing and saves the trace in the output directory (.zip for `npx playwright show-trace`, or .html).',
      inputSchema: { path: z.string().optional().describe('File name (default trace-<time>.zip)') },
      annotations: readOnly,
    },
    ({ path }) =>
      run(async () => {
        const app = await context.ensureApp();
        const file = await context.outputPath(path, `trace-${Date.now()}.zip`);
        await app.tracing.stop({ path: file });
        return [text(`Trace saved to ${file}${file.endsWith('.zip') ? `; open it with: npx playwright show-trace ${file}` : ''}`)];
      }),
  );

  server.registerTool(
    'qt_start_video',
    {
      title: 'Start video',
      description: 'Starts recording all windows (with the mouse pointer) into a video file in the output directory (.mp4, .webm, .gif...; needs ffmpeg).',
      inputSchema: {
        path: z.string().optional().describe('File name (default video-<time>.mp4)'),
        fps: z.number().int().min(1).max(60).optional(),
      },
      annotations: readOnly,
    },
    ({ path, fps }) =>
      run(async () => {
        const app = await context.ensureApp();
        if (context.recordingVideo) throw new ToolError('A video is already being recorded; stop it with qt_stop_video.');
        const file = await context.outputPath(path, `video-${Date.now()}.mp4`);
        context.recordingVideo = await app.startVideo(file, fps ? { fps } : {});
        return [text(`Recording ${file}; stop with qt_stop_video.`)];
      }),
  );

  server.registerTool(
    'qt_stop_video',
    {
      title: 'Stop video',
      description: 'Stops the video recording and finalizes the file.',
      inputSchema: {},
      annotations: readOnly,
    },
    () =>
      run(async () => {
        const video = context.recordingVideo;
        if (!video) throw new ToolError('No video is being recorded.');
        context.recordingVideo = undefined;
        return [text(`Video saved to ${await video.stop()}`)];
      }),
  );

  server.registerTool(
    'qt_generate_test',
    {
      title: 'Generate test',
      description:
        'Returns a qt-playwright test (for @playwright/test with the qt-playwright fixtures) that repeats the actions and passing assertions since the application was launched or connected. Refs are replaced by the locators codegen chooses: role + name, label, placeholder, getByTestId (matches the objectName), QML id, text. Exploratory steps are included too: call it with clear: true before the steps a test should contain. Failed assertions are not included. Optionally saves it in the output directory.',
      inputSchema: {
        name: z.string().optional().describe('Test name'),
        path: z.string().optional().describe('Save as this file in the output directory, e.g. "login.spec.ts"'),
        clear: z.boolean().optional().describe('Forget the recorded steps afterwards, to record a new test from here'),
      },
      annotations: readOnly,
    },
    ({ name, path, clear }) =>
      run(async () => {
        const app = context.app;
        const header = app
          ? [`// Recorded with the qt-playwright MCP server; the application was ${context.session}`, '// (the `app` fixture starts it as configured in qtApp of playwright.config.ts)']
          : [];
        const code = renderTestFile(context.code.flatMap((c) => c.split('\n')), name ?? 'recorded', header);
        let note = '';
        if (path) {
          const file = await context.outputPath(path, 'recorded.spec.ts');
          await writeFile(file, code);
          note = `Saved to ${file}\n\n`;
        }
        if (clear) context.code.length = 0;
        const config = context.fixtureConfig
          ? `\n\nRun it with \`npx playwright test\` and this in playwright.config.ts:\n\`\`\`ts\nuse: { ${context.fixtureConfig} },\n\`\`\``
          : '';
        return [text(`${note}\`\`\`ts\n${code}\`\`\`${config}`)];
      }),
  );

  return server;
}

export interface RunMcpServerOptions extends McpServerOptions {
  /** Serve Streamable HTTP on this port instead of stdio (0: any free port). */
  port?: number;
  /** Interface for HTTP (default 127.0.0.1). */
  host?: string;
  /**
   * Bearer token HTTP clients must send. Default: $QTPW_MCP_TOKEN; when listening on a
   * non-loopback interface without one, a random token is generated and logged.
   */
  token?: string;
  /** Log lines (default: stderr). */
  log?: (line: string) => void;
}

export interface RunningMcpServer {
  /** http://host:port/mcp for HTTP; undefined for stdio. */
  url?: string;
  token?: string;
  context: McpContext;
  close(): Promise<void>;
}

const isLoopback = (host: string) => host === 'localhost' || host === '::1' || host.startsWith('127.');

/** The host name of an Origin header ('' for "null" or garbage). */
function originHost(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/** Runs the MCP server on stdio (default) or Streamable HTTP (`port`). */
export async function runMcpServer(options: RunMcpServerOptions = {}): Promise<RunningMcpServer> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const context = new McpContext(options);
  if (options.port === undefined) {
    const server = createMcpServer(context);
    const transport = new StdioServerTransport();
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        await context.close();
        await server.close().catch(() => undefined);
      })());
    // the client ends the session by closing our stdin
    process.stdin.once('end', () => void close().then(() => process.exit(0)));
    await server.connect(transport);
    return { context, close };
  }

  const host = options.host ?? '127.0.0.1';
  let token = options.token ?? process.env.QTPW_MCP_TOKEN ?? '';
  if (!token && !isLoopback(host)) {
    token = randomBytes(16).toString('hex');
    log(`qt-playwright MCP token: ${token}`);
  }
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  const authorized = (req: IncomingMessage) => {
    if (!token) return true;
    const given = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '');
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const reply = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
  };

  const http: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/mcp') return reply(res, 404, 'not found (the endpoint is /mcp)');
      // a web page must not be able to reach a loopback server through DNS rebinding
      if (isLoopback(host)) {
        const hostname = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
        if (!isLoopback(hostname)) return reply(res, 403, 'forbidden host');
        const origin = req.headers.origin;
        if (origin && !isLoopback(originHost(origin))) return reply(res, 403, 'forbidden origin');
      }
      if (!authorized(req)) return reply(res, 401, 'unauthorized: send "Authorization: Bearer <token>"');
      let body: unknown;
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        try {
          body = JSON.parse(Buffer.concat(chunks).toString() || 'null');
        } catch {
          return reply(res, 400, 'invalid JSON');
        }
      }
      const sessionId = req.headers['mcp-session-id'];
      let session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!session) {
        if (sessionId) return reply(res, 404, 'unknown session');
        if (req.method !== 'POST' || !isInitializeRequest(body)) return reply(res, 400, 'no session: send an initialize request first');
        const server = createMcpServer(context);
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        session = { transport, server };
      }
      await session.transport.handleRequest(req, res, body);
    })().catch((e) => {
      if (!res.headersSent) reply(res, 500, String((e as Error).message ?? e));
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, host, () => resolve());
  });
  const { port } = http.address() as AddressInfo;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp`;
  return {
    url,
    token: token || undefined,
    context,
    close: async () => {
      for (const { transport, server } of [...sessions.values()]) {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
      sessions.clear();
      await context.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections?.();
    },
  };
}
