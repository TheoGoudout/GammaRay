// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

// `qt-playwright mcp install <agent>`: registers the MCP server with a coding agent by
// writing its configuration file (or, for Claude Code's user/local scopes, through
// `claude mcp add`). The server is started as `<node> <this cli.js> mcp <options>` with
// absolute paths, so it works from any directory and without a published npm package.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { RunMcpServerOptions } from './mcp';

/** Thrown for invalid command lines; the message is meant for the user. */
export class UsageError extends Error {}

/**
 * Parses the options of `qt-playwright mcp`. Also returns them normalized for writing into a
 * configuration file: local paths (--app unless --remote, --output-dir, --gammaray) absolute.
 */
export function parseMcpArgs(argv: string[], cwd = process.cwd()): { options: RunMcpServerOptions; argv: string[] } {
  const options: RunMcpServerOptions = { apps: [] };
  const normalized: string[] = [];
  const apps: string[] = [];
  let remote: string | undefined;
  let remoteToken: string | undefined;
  const args = [...argv];
  const value = (opt: string) => {
    const v = args.shift();
    if (v === undefined) throw new UsageError(`${opt} needs a value`);
    return v;
  };
  const number = (opt: string) => {
    const v = Number(value(opt));
    if (!Number.isFinite(v) || v < 0) throw new UsageError(`${opt} needs a number`);
    return v;
  };
  while (args.length) {
    const opt = args.shift()!;
    if (opt === '--app') apps.push(value(opt));
    else if (opt === '--args') normalized.push(opt, (options.args = value(opt).split(' ').filter(Boolean)).join(' '));
    else if (opt === '--remote') normalized.push(opt, (remote = value(opt)));
    else if (opt === '--remote-token') normalized.push(opt, (remoteToken = value(opt)));
    else if (opt === '--connect') normalized.push(opt, (options.connect = value(opt)));
    else if (opt === '--headless') normalized.push(opt), (options.headless = true);
    else if (opt === '--timeout') normalized.push(opt, String((options.timeout = number(opt))));
    else if (opt === '--output-dir') normalized.push(opt, (options.outputDir = resolve(cwd, value(opt))));
    else if (opt === '--no-snapshot') normalized.push(opt), (options.snapshotAfterAction = false);
    else if (opt === '--port') normalized.push(opt, String((options.port = number(opt))));
    else if (opt === '--host') normalized.push(opt, (options.host = value(opt)));
    else if (opt === '--token') normalized.push(opt, (options.token = value(opt)));
    else if (opt === '--gammaray') normalized.push(opt, (options.gammaray = resolve(cwd, value(opt))));
    else throw new UsageError(`unknown option ${opt}`);
  }
  // executables of a remote server are paths on that machine
  for (const app of apps) {
    const path = remote ? app : resolve(cwd, app);
    options.apps!.push(path);
    normalized.push('--app', path);
  }
  if (!options.apps!.length) options.apps = undefined;
  if (remote) options.remote = { url: remote, token: remoteToken };
  return { options, argv: normalized };
}

/** How an agent starts the server. */
export interface ServerCommand {
  command: string;
  args: string[];
}

type Format = 'mcpServers' | 'vscode' | 'codex';
export type Scope = 'project' | 'user' | 'local';

export interface AgentInfo {
  id: string;
  name: string;
  aliases: string[];
  /** Supported scopes, the default first. */
  scopes: Scope[];
}

interface Agent extends AgentInfo {
  format: Format;
  /** The configuration file for @p scope, or undefined when it is configured through a CLI. */
  file(scope: Scope, env: InstallEnv): string | undefined;
  /** What to tell the user after installing. */
  next: string;
}

/** Where things are; parameters so that tests can use a fake home and platform. */
export interface InstallEnv {
  dir: string;
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/** The per-user application data directory of a desktop application (Claude, VS Code). */
function appData(e: InstallEnv, app: string): string {
  if (e.platform === 'darwin') return join(e.home, 'Library', 'Application Support', app);
  if (e.platform === 'win32') return join(e.env.APPDATA ?? join(e.home, 'AppData', 'Roaming'), app);
  return join(e.env.XDG_CONFIG_HOME ?? join(e.home, '.config'), app);
}

const AGENTS: Agent[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    aliases: ['claude'],
    scopes: ['project', 'user', 'local'],
    format: 'mcpServers',
    // user and local scope live in ~/.claude.json, which `claude mcp add` maintains
    file: (scope, e) => (scope === 'project' ? join(e.dir, '.mcp.json') : undefined),
    next: 'Start Claude Code in that directory (it asks to approve project servers once); /mcp shows the server.',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    aliases: [],
    scopes: ['user'],
    format: 'mcpServers',
    file: (_scope, e) => join(appData(e, 'Claude'), 'claude_desktop_config.json'),
    next: 'Restart Claude Desktop.',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    aliases: [],
    scopes: ['project', 'user'],
    format: 'mcpServers',
    file: (scope, e) => (scope === 'project' ? join(e.dir, '.cursor', 'mcp.json') : join(e.home, '.cursor', 'mcp.json')),
    next: 'Enable the server in Cursor Settings > MCP if it is not enabled automatically.',
  },
  {
    id: 'vscode',
    name: 'VS Code (GitHub Copilot)',
    aliases: ['code', 'copilot'],
    scopes: ['project', 'user'],
    format: 'vscode',
    file: (scope, e) => (scope === 'project' ? join(e.dir, '.vscode', 'mcp.json') : join(appData(e, 'Code'), 'User', 'mcp.json')),
    next: 'Start the server from the MCP view or the mcp.json file in VS Code, then use it in Copilot agent mode.',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    aliases: [],
    scopes: ['user'],
    format: 'mcpServers',
    file: (_scope, e) => join(e.home, '.codeium', 'windsurf', 'mcp_config.json'),
    next: 'Refresh the MCP servers in Windsurf (Cascade > MCP).',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    aliases: [],
    scopes: ['user'],
    format: 'codex',
    file: (_scope, e) => join(e.env.CODEX_HOME ?? join(e.home, '.codex'), 'config.toml'),
    next: 'Start a new Codex session; /mcp lists the server.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    aliases: [],
    scopes: ['project', 'user'],
    format: 'mcpServers',
    file: (scope, e) => (scope === 'project' ? join(e.dir, '.gemini', 'settings.json') : join(e.home, '.gemini', 'settings.json')),
    next: 'Start Gemini CLI; /mcp lists the server.',
  },
];

/** The agents `qt-playwright mcp install` knows. */
export function agents(): AgentInfo[] {
  return AGENTS.map(({ id, name, aliases, scopes }) => ({ id, name, aliases, scopes }));
}

function findAgent(id: string): Agent {
  const agent = AGENTS.find((a) => a.id === id || a.aliases.includes(id));
  if (!agent) throw new UsageError(`unknown agent "${id}" (known: ${AGENTS.map((a) => a.id).join(', ')})`);
  return agent;
}

/** The `gammaray` launcher to put into the configuration: $QT_PLAYWRIGHT_GAMMARAY, else from PATH. */
export function findGammaray(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env.QT_PLAYWRIGHT_GAMMARAY) return resolve(env.QT_PLAYWRIGHT_GAMMARAY);
  const names = platform === 'win32' ? ['gammaray.exe'] : ['gammaray'];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return undefined;
}

/** The configuration file content with the server @p name added or replaced. */
export function updatedConfig(format: Format, current: string | undefined, name: string, server: ServerCommand): string {
  if (format === 'codex') return updatedCodexConfig(current ?? '', name, server);
  let config: Record<string, any> = {};
  if (current && current.trim()) {
    try {
      config = JSON.parse(current);
    } catch (e) {
      throw new Error(`cannot parse the existing file (${(e as Error).message}); add the entry by hand (see --print)`);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('the existing file is not a JSON object');
  }
  const key = format === 'vscode' ? 'servers' : 'mcpServers';
  const entry = format === 'vscode' ? { type: 'stdio', command: server.command, args: server.args } : { command: server.command, args: server.args };
  config[key] = { ...(config[key] ?? {}), [name]: entry };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Codex's TOML: replaces the [mcp_servers.<name>] table or appends it. */
function updatedCodexConfig(current: string, name: string, server: ServerCommand): string {
  // TOML basic strings accept JSON's escapes
  const header = `[mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}]`;
  const table = `${header}\ncommand = ${JSON.stringify(server.command)}\nargs = [${server.args.map((a) => JSON.stringify(a)).join(', ')}]\n`;
  const lines = current.split('\n');
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current.trim() ? '\n' : ''}${table}`;
  // the table ends at the next table header that is not one of its sub-tables (e.g. .env)
  const subTable = `${header.slice(0, -1)}.`;
  let end = start + 1;
  while (end < lines.length && !(lines[end].trim().startsWith('[') && !lines[end].trim().startsWith(subTable))) ++end;
  const after = lines.slice(end);
  return [...lines.slice(0, start), ...table.trimEnd().split('\n'), ...(after.length ? ['', ...after] : [''])].join('\n');
}

export interface InstallOptions {
  agent: string;
  scope?: Scope;
  /** Name of the server in the agent's configuration (default "qt"). */
  name?: string;
  /** Only print what would be configured. */
  print?: boolean;
  /** Options for `qt-playwright mcp`, already normalized (see parseMcpArgs). */
  serverArgs: string[];
  /** The node executable and this package's cli.js. */
  node?: string;
  cli?: string;
  environment?: Partial<InstallEnv>;
  /** Runs `claude` (for tests). */
  run?: (command: string, args: string[]) => { status: number | null; error?: Error; stderr?: string };
}

export interface InstallResult {
  /** Human-readable report. */
  message: string;
  /** The file written (or that would be written). */
  file?: string;
  /** Its new content, or the command to run. */
  content: string;
}

/** Registers the MCP server with an agent (see the module comment). */
export function install(options: InstallOptions): InstallResult {
  const agent = findAgent(options.agent);
  const scope = options.scope ?? agent.scopes[0];
  if (!agent.scopes.includes(scope)) throw new UsageError(`${agent.name} supports --scope ${agent.scopes.join(' or ')}`);
  const e: InstallEnv = {
    dir: resolve(options.environment?.dir ?? process.cwd()),
    home: options.environment?.home ?? homedir(),
    platform: options.environment?.platform ?? process.platform,
    env: options.environment?.env ?? process.env,
  };
  const name = options.name ?? 'qt';
  const server: ServerCommand = {
    command: options.node ?? process.execPath,
    args: [options.cli ?? join(__dirname, 'cli.js'), 'mcp', ...options.serverArgs],
  };
  const warnings: string[] = [];
  if (!options.serverArgs.includes('--gammaray') && !options.serverArgs.includes('--connect')) {
    const gammaray = findGammaray(e.env, e.platform);
    if (gammaray) server.args.push('--gammaray', gammaray);
    else if (!options.serverArgs.includes('--remote'))
      warnings.push('warning: gammaray was not found ($QT_PLAYWRIGHT_GAMMARAY, PATH); pass --gammaray /path/to/bin/gammaray');
  }

  const file = agent.file(scope, e);
  if (!file) {
    // Claude Code user/local scope
    const args = ['mcp', 'add', '--scope', scope, name, '--', server.command, ...server.args];
    const content = `claude ${args.map(shellQuote).join(' ')}`;
    if (options.print) return { message: content, content };
    const run = options.run ?? ((c: string, a: string[]) => spawnSync(c, a, { encoding: 'utf8', cwd: e.dir }));
    // replace an existing entry of that name
    run('claude', ['mcp', 'remove', '--scope', scope, name]);
    const r = run('claude', args);
    if (r.error) throw new Error(`could not run claude (${r.error.message}); is Claude Code installed? Or use --scope project`);
    if (r.status !== 0) throw new Error(`claude mcp add failed: ${r.stderr ?? ''}`.trim());
    return { message: [...warnings, `Added "${name}" to ${agent.name} (${scope} scope).`, agent.next].join('\n'), content };
  }

  const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const content = updatedConfig(agent.format, current, name, server);
  if (options.print) return { message: `# ${file}\n${content}`, file, content };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.qt-playwright-tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
  return { message: [...warnings, `${current ? 'Updated' : 'Created'} ${file} with the MCP server "${name}".`, agent.next].join('\n'), file, content };
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `qt-playwright mcp install` command line: <agent> [--scope s] [--name n] [--print] [--dir d] [server options]. */
export function parseInstallArgs(argv: string[]): Omit<InstallOptions, 'serverArgs'> & { serverArgv: string[] } {
  const args = [...argv];
  const agent = args.shift();
  if (!agent || agent.startsWith('-')) throw new UsageError('which agent? qt-playwright mcp install <agent> [options]');
  const result: Omit<InstallOptions, 'serverArgs'> & { serverArgv: string[] } = { agent, serverArgv: [], environment: {} };
  while (args.length) {
    const opt = args.shift()!;
    const value = () => {
      const v = args.shift();
      if (v === undefined) throw new UsageError(`${opt} needs a value`);
      return v;
    };
    if (opt === '--scope') {
      const scope = value();
      if (scope !== 'project' && scope !== 'user' && scope !== 'local') throw new UsageError('--scope is project, user or local');
      result.scope = scope;
    } else if (opt === '--name') result.name = value();
    else if (opt === '--print') result.print = true;
    else if (opt === '--dir') result.environment!.dir = value();
    else if (opt === '--') result.serverArgv.push(...args.splice(0));
    else result.serverArgv.push(opt); // a server option (validated by parseMcpArgs)
  }
  if (result.environment!.dir && !isAbsolute(result.environment!.dir)) result.environment!.dir = resolve(result.environment!.dir);
  return result;
}
