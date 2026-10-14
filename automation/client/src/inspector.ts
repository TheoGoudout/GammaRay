// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { QtApp } from './app';
import { renderAction, type CodeRecorder } from './codegen';
import { addStepListener, removeStepListener, type StepInfo, type StepListener } from './instrumentation';
import { Locator } from './locator';

export interface InspectorOptions {
  /** Port of the local web server (default: any free port). */
  port?: number;
  /** Open the inspector in a browser (default: when not on CI and a display is available). */
  open?: boolean;
  /** Pause before the next action (stepping), like PWDEBUG=1. */
  step?: boolean;
}

interface ActionEntry {
  id: number;
  title: string;
  status: 'running' | 'passed' | 'failed';
  duration?: number;
  error?: string;
}

interface Waiter {
  resolve: () => void;
}

/**
 * A web-based inspector, the Qt adaptation of Playwright's Inspector: a live view of the
 * application's windows where locators can be picked by clicking, a locator playground that
 * highlights matches inside the application, stepping through a test (app.pause(),
 * QTPW_DEBUG=1) and recording (codegen). The server only listens on 127.0.0.1 and every
 * request needs the random token in the URL.
 */
export class Inspector {
  private server: Server | undefined;
  private readonly token = randomBytes(12).toString('hex');
  private actions: ActionEntry[] = [];
  private waiter: Waiter | undefined;
  private pausedAt: { title: string; reason: string } | undefined;
  private stepping: boolean;
  private recorder: CodeRecorder | undefined;
  private readonly listener: StepListener;
  private closed = false;
  url = '';

  private constructor(
    private readonly app: QtApp,
    private readonly options: InspectorOptions,
  ) {
    this.stepping = !!options.step;
    this.listener = {
      before: async (title, step) => {
        this.actions.push({ id: step.id, title, status: 'running' });
        if (this.actions.length > 500) this.actions.shift();
        // actions that deliver input pause once their target is known (input hook)
        if (this.stepping && !willSendInput(title)) await this.pauseHere(title, 'before');
      },
      input: async (step, input) => {
        if (!this.stepping) return;
        if (input.handle !== undefined)
          await this.app.connection.call('highlight', { handles: [input.handle], label: step.title }).catch(() => undefined);
        await this.pauseHere(step.title, 'before');
        await this.app.connection.call('hideHighlight', {}).catch(() => undefined);
      },
      after: (_title, error, duration, step: StepInfo) => {
        const entry = this.actions.find((a) => a.id === step.id);
        if (!entry) return;
        entry.status = error ? 'failed' : 'passed';
        entry.duration = duration;
        if (error) entry.error = String((error as Error).message ?? error);
      },
    };
  }

  /** Starts the inspector for @p app (prints its URL to stderr). */
  static async start(app: QtApp, options: InspectorOptions = {}): Promise<Inspector> {
    const inspector = new Inspector(app, options);
    await inspector.listen();
    addStepListener(inspector.listener);
    process.stderr.write(`qt-playwright inspector: ${inspector.url}\n`);
    const open = options.open ?? (!process.env.CI && process.env.QTPW_INSPECTOR_BROWSER !== '0' && hasDisplay());
    if (open) openBrowser(inspector.url);
    return inspector;
  }

  get isPaused(): boolean {
    return !!this.waiter;
  }

  /** Pauses until Resume or Step over is clicked in the inspector (or Enter in the terminal). */
  async pause(reason = 'app.pause()'): Promise<void> {
    await this.pauseHere(reason, 'pause');
  }

  /** Resumes a paused test; with @p step, pauses again before the next action. */
  resume(step = false): void {
    this.stepping = step;
    const w = this.waiter;
    this.waiter = undefined;
    this.pausedAt = undefined;
    w?.resolve();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    removeStepListener(this.listener);
    this.resume();
    await this.recorder?.stop().catch(() => undefined);
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections?.();
  }

  private async pauseHere(title: string, reason: string): Promise<void> {
    if (this.closed || this.app.connection.isClosed) return;
    this.pausedAt = { title, reason };
    process.stderr.write(`Paused ${reason === 'before' ? 'before' : 'at'} ${title} - resume in ${this.url}${process.stdin.isTTY ? ' or press Enter' : ''}\n`);
    await new Promise<void>((resolve) => {
      this.waiter = { resolve };
      if (process.stdin.isTTY) {
        const onData = () => this.resume(false);
        process.stdin.resume();
        process.stdin.once('data', onData);
        const done = this.waiter.resolve;
        this.waiter.resolve = () => {
          process.stdin.off('data', onData);
          process.stdin.pause();
          done();
        };
      }
    });
  }

  private async listen(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => send(res, 500, { error: String((e as Error)?.message ?? e) }));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port ?? 0, '127.0.0.1', () => resolve());
    });
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/${this.token}/`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const prefix = `/${this.token}/`;
    if (!url.pathname.startsWith(prefix)) return send(res, 404, { error: 'not found' });
    const route = url.pathname.slice(prefix.length);
    const body = req.method === 'POST' ? await readJson(req) : {};
    const app = this.app;
    switch (route) {
      case '':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(INSPECTOR_HTML);
        return;
      case 'api/state':
        return send(res, 200, {
          appName: app.info.appName,
          pid: app.pid,
          running: !app.connection.isClosed,
          paused: this.pausedAt ?? null,
          actions: this.actions.slice(-200),
          recording: !!this.recorder,
          code: this.recorder?.actions.map(renderAction) ?? [],
        });
      case 'api/screenshot': {
        const shot = await app.connection.call<{ image: string; canvas: unknown; width: number; height: number }>('screenshotAll', {
          format: 'jpeg',
          quality: 75,
          scale: 1,
        });
        return send(res, 200, shot);
      }
      case 'api/tree':
        return send(res, 200, await app.connection.call('snapshotTree', { maxNodes: 4000 }));
      case 'api/pick': {
        const handle = Number(body.handle);
        const [locator, info] = await Promise.all([
          app.connection.call<{ code: string; selector: string }>('locatorFor', { handle }),
          app.connection.call('describe', { handle }),
        ]);
        await app.connection.call('highlight', { handles: [handle], label: locator.code.replace(/^app\./, '') });
        return send(res, 200, { ...locator, info });
      }
      case 'api/locate': {
        const expression = String(body.expression ?? '').trim();
        let locator: unknown;
        try {
          // the same expressions as in a test: getByRole('button', { name: 'OK' }).first() ...
          locator = new Function('app', `return (app.${expression.replace(/^app\./, '')});`)(app);
        } catch (e) {
          return send(res, 200, { error: String((e as Error).message) });
        }
        if (!(locator instanceof Locator)) return send(res, 200, { error: 'the expression is not a locator' });
        try {
          const elements = await locator.elements();
          const boxes = [];
          for (const e of elements.slice(0, 50)) {
            const info = await app.connection.call<{ geometry?: unknown; visible: boolean }>('describe', { handle: e.handle });
            if (info.visible && info.geometry) boxes.push(info.geometry);
          }
          await app.connection.call('highlight', { handles: elements.map((e) => e.handle), label: expression });
          return send(res, 200, { count: elements.length, boxes, selector: locator.selector });
        } catch (e) {
          return send(res, 200, { error: String((e as Error).message) });
        }
      }
      case 'api/hideHighlight':
        await app.connection.call('hideHighlight', {});
        return send(res, 200, {});
      case 'api/resume':
        this.resume(false);
        return send(res, 200, {});
      case 'api/step':
        this.resume(true);
        return send(res, 200, {});
      case 'api/record':
        if (body.on && !this.recorder) this.recorder = await app.startCodegen();
        else if (!body.on && this.recorder) {
          await this.recorder.stop();
          this.recorder = undefined;
        }
        return send(res, 200, { recording: !!this.recorder });
      default:
        return send(res, 404, { error: `unknown route ${route}` });
    }
  }
}

/** Locator actions report their target before sending input; everything else pauses before. */
function willSendInput(title: string): boolean {
  return /\.(click|dblclick|tap|hover|fill|clear|press|pressSequentially|type|check|uncheck|setChecked|selectOption|selectText|dragTo|dragBy|setInputFiles|scroll|focus)$/.test(title);
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

function hasDisplay(): boolean {
  return process.platform !== 'linux' || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    // no browser: the URL was printed
  }
}

const INSPECTOR_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>qt-playwright Inspector</title>
<style>
:root { color-scheme: light dark; --fg:#1f2328; --bg:#fff; --panel:#f6f8fa; --muted:#59636e; --line:#d1d9e0; --accent:#0969da; --bad:#cf222e; --ok:#1a7f37; --hl:rgba(111,168,220,.45); }
@media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --bg:#0d1117; --panel:#161b22; --muted:#9198a1; --line:#30363d; --accent:#4493f8; --bad:#f85149; --ok:#3fb950; } }
* { box-sizing: border-box; }
body { margin:0; font:13px system-ui, sans-serif; color:var(--fg); background:var(--bg); height:100vh; display:flex; flex-direction:column; }
header { display:flex; gap:8px; align-items:center; padding:8px 12px; border-bottom:1px solid var(--line); background:var(--panel); flex-wrap:wrap; }
header h1 { font-size:14px; margin:0 8px 0 0; }
button { font:inherit; padding:4px 10px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); cursor:pointer; }
button:disabled { opacity:.45; cursor:default; }
button.on { background:var(--accent); color:#fff; border-color:var(--accent); }
#status { color:var(--muted); flex:1; min-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#status.paused { color:var(--bad); font-weight:600; }
main { flex:1; display:flex; min-height:0; }
#viewWrap { flex:1; overflow:auto; padding:12px; background:repeating-conic-gradient(var(--panel) 0 25%, var(--bg) 0 50%) 0 0/16px 16px; }
#view { position:relative; display:inline-block; }
#view img { display:block; }
#view .box { position:absolute; background:var(--hl); outline:1px solid #3d7fc1; pointer-events:none; }
#view .hover { position:absolute; outline:2px solid #e8590c; pointer-events:none; }
#view.picking { cursor:crosshair; }
aside { width:420px; max-width:45vw; border-left:1px solid var(--line); display:flex; flex-direction:column; min-height:0; }
section { padding:10px 12px; border-bottom:1px solid var(--line); }
section h2 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0 0 6px; }
#locator { width:100%; font:12px ui-monospace, monospace; padding:6px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); }
#locateResult { margin-top:6px; color:var(--muted); font-size:12px; }
#locateResult.error { color:var(--bad); }
#info { font:12px ui-monospace, monospace; white-space:pre-wrap; color:var(--muted); margin:6px 0 0; }
#actions { list-style:none; margin:0; padding:0; overflow:auto; flex:1; }
#actions li { padding:4px 12px; font:12px ui-monospace, monospace; border-bottom:1px solid var(--line); display:flex; gap:6px; }
#actions li .t { flex:1; word-break:break-all; }
#actions li.failed .t { color:var(--bad); }
#actions li.running .t { color:var(--accent); }
#actions li .d { color:var(--muted); }
#code { font:12px ui-monospace, monospace; white-space:pre; overflow:auto; max-height:180px; margin:0; background:var(--panel); padding:6px; border-radius:6px; }
@media (max-width: 760px) { main { flex-direction:column; } aside { width:auto; max-width:none; border-left:0; border-top:1px solid var(--line); } }
</style></head>
<body>
<header>
  <h1>qt-playwright Inspector</h1>
  <button id="resume" title="Resume (F8)" disabled>&#9654; Resume</button>
  <button id="step" title="Step over (F10)" disabled>&#8631; Step over</button>
  <button id="pick" title="Pick locator">&#9678; Pick locator</button>
  <button id="record" title="Record actions as code">&#9679; Record</button>
  <span id="status">Connecting...</span>
</header>
<main>
  <div id="viewWrap"><div id="view"><img id="shot" alt="Application windows"></div></div>
  <aside>
    <section>
      <h2>Locator</h2>
      <input id="locator" spellcheck="false" placeholder="getByRole('button', { name: 'Login' })" aria-label="Locator">
      <div id="locateResult"></div>
      <div id="info"></div>
    </section>
    <section id="recordSection" hidden>
      <h2>Recorded code <button id="copy" style="float:right;font-size:11px;padding:1px 6px">Copy</button></h2>
      <pre id="code"></pre>
    </section>
    <section style="padding-bottom:4px"><h2>Actions</h2></section>
    <ul id="actions"></ul>
  </aside>
</main>
<script>
const api = (path, body) => fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const $ = (id) => document.getElementById(id);
let canvas = { x: 0, y: 0, width: 0, height: 0 }, tree = [], picking = false, boxes = [], hover = null, state = {};
function flatten(nodes, out = []) { for (const n of nodes) { if (n.geometry) out.push(n); flatten(n.children || [], out); } return out; }
function render() {
  const view = $('view');
  view.querySelectorAll('.box,.hover').forEach((e) => e.remove());
  for (const b of boxes) { const d = document.createElement('div'); d.className = 'box'; place(d, b); view.appendChild(d); }
  if (hover) { const d = document.createElement('div'); d.className = 'hover'; place(d, hover.geometry); view.appendChild(d); }
}
function place(d, g) { Object.assign(d.style, { left: (g.x - canvas.x) + 'px', top: (g.y - canvas.y) + 'px', width: g.width + 'px', height: g.height + 'px' }); }
async function refreshShot() {
  try {
    const s = await api('api/screenshot');
    canvas = s.canvas; $('shot').src = 'data:image/jpeg;base64,' + s.image; $('shot').style.width = canvas.width + 'px';
    if (picking) tree = flatten((await api('api/tree')).windows);
  } catch {}
}
async function refreshState() {
  try {
    state = await api('api/state');
    const st = $('status');
    st.textContent = !state.running ? 'Application closed' : state.paused ? 'Paused ' + (state.paused.reason === 'before' ? 'before ' : 'at ') + state.paused.title : 'Running ' + state.appName + ' (pid ' + state.pid + ')';
    st.className = state.paused ? 'paused' : '';
    $('resume').disabled = $('step').disabled = !state.paused;
    $('record').classList.toggle('on', state.recording);
    $('recordSection').hidden = !state.recording && !state.code.length;
    $('code').textContent = state.code.join('\\n');
    const list = $('actions'); list.textContent = '';
    for (const a of state.actions.slice().reverse()) {
      const li = document.createElement('li'); li.className = a.status;
      li.innerHTML = '<span class="t"></span><span class="d"></span>';
      li.querySelector('.t').textContent = a.title + (a.error ? '\\n' + a.error.split('\\n')[0] : '');
      li.querySelector('.d').textContent = a.duration !== undefined ? a.duration + ' ms' : '';
      list.appendChild(li);
    }
  } catch { $('status').textContent = 'Disconnected'; }
}
async function locate() {
  const expression = $('locator').value.trim();
  if (!expression) { boxes = []; render(); $('locateResult').textContent = ''; await api('api/hideHighlight', {}); return; }
  const r = await api('api/locate', { expression });
  const out = $('locateResult');
  out.className = r.error ? 'error' : '';
  out.textContent = r.error ? r.error : r.count === 1 ? '1 element' : r.count + ' elements' + (r.count === 0 ? '' : ' (strict mode needs exactly one for actions)');
  boxes = r.boxes || []; render();
}
let locateTimer; $('locator').addEventListener('input', () => { clearTimeout(locateTimer); locateTimer = setTimeout(locate, 250); });
$('pick').onclick = async () => { picking = !picking; $('pick').classList.toggle('on', picking); $('view').classList.toggle('picking', picking); if (picking) tree = flatten((await api('api/tree')).windows); hover = null; render(); };
function hit(ev) {
  const r = $('shot').getBoundingClientRect(); const x = ev.clientX - r.left + canvas.x, y = ev.clientY - r.top + canvas.y;
  let best = null;
  for (const n of tree) { const g = n.geometry; if (x >= g.x && y >= g.y && x < g.x + g.width && y < g.y + g.height && (!best || g.width * g.height <= best.geometry.width * best.geometry.height)) best = n; }
  return best;
}
$('view').addEventListener('mousemove', (ev) => { if (!picking) return; hover = hit(ev); render(); });
$('view').addEventListener('click', async (ev) => {
  if (!picking) return;
  const n = hit(ev); if (!n) return;
  picking = false; $('pick').classList.remove('on'); $('view').classList.remove('picking'); hover = null;
  const r = await api('api/pick', { handle: n.handle });
  $('locator').value = r.code.replace(/^app\\./, '');
  const i = r.info || {};
  $('info').textContent = [i.type && 'type: ' + i.type, i.role && 'role: ' + i.role, i.accessibleName && 'name: ' + JSON.stringify(i.accessibleName), i.objectName && 'objectName: ' + i.objectName, i.text && 'text: ' + JSON.stringify(i.text)].filter(Boolean).join('\\n');
  await locate();
});
$('resume').onclick = () => api('api/resume', {}).then(refreshState);
$('step').onclick = () => api('api/step', {}).then(refreshState);
$('record').onclick = () => api('api/record', { on: !state.recording }).then(refreshState);
$('copy').onclick = () => navigator.clipboard?.writeText($('code').textContent);
document.addEventListener('keydown', (ev) => { if (ev.key === 'F8') { ev.preventDefault(); $('resume').click(); } if (ev.key === 'F10') { ev.preventDefault(); $('step').click(); } });
refreshShot(); refreshState();
setInterval(refreshState, 500);
setInterval(() => { if (!document.hidden) refreshShot(); }, 700);
</script></body></html>
`;
