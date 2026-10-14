// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { QtApp } from './app';
import { addStepListener, removeStepListener, type StepListener } from './instrumentation';
import { PlaywrightTraceRecorder } from './playwrighttrace';

export interface TracingStartOptions {
  /** Capture screenshots of all windows (film strip and snapshots; default true). */
  screenshots?: boolean;
  /** Capture DOM-like snapshots before, during and after each action (default true). */
  snapshots?: boolean;
  /** Scale of the screenshots (default 1). */
  scale?: number;
  /** Title shown in the trace viewer. */
  title?: string;
}

export interface TracingStopOptions {
  /**
   * Where to write the trace. A `.zip` path (or no path) gives Playwright's trace format,
   * for `npx playwright show-trace`; a `.html` path gives a self-contained HTML viewer.
   */
  path?: string;
  /** Overrides the format implied by the path. */
  format?: 'zip' | 'html';
}

interface TraceEntry {
  title: string;
  start: number;
  duration: number;
  error?: string;
  screenshot?: string; // resource name
  group?: boolean;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Records API calls with timing, call logs, errors, screenshots and element snapshots
 * (Qt adaptation of Playwright's tracing). stop() writes Playwright's trace.zip format,
 * which `npx playwright show-trace` and the HTML report open, or a self-contained HTML
 * viewer.
 */
export class Tracing {
  private entries: TraceEntry[] = [];
  private listener: StepListener | undefined;
  private options: TracingStartOptions = {};
  private recorder: PlaywrightTraceRecorder | undefined;
  private startedAt = 0;

  constructor(private readonly app: QtApp) {}

  get isRecording(): boolean {
    return !!this.listener;
  }

  async start(options: TracingStartOptions = {}): Promise<void> {
    if (this.listener) throw new Error('tracing has already been started');
    this.options = { screenshots: true, snapshots: true, scale: 1, ...options };
    this.entries = [];
    this.startedAt = Date.now();
    const recorder = new PlaywrightTraceRecorder(this.app, {
      title: options.title,
      screenshots: this.options.screenshots,
      snapshots: this.options.snapshots,
      scale: this.options.scale,
    });
    this.recorder = recorder;
    await recorder.start();
    this.entries.push({ title: 'tracing.start', start: this.startedAt, duration: 0, screenshot: recorder.lastScreenshot });
    this.listener = {
      before: async (_title, step) => recorder.before(step),
      input: async (step, input) => recorder.input(step, input),
      log: (step, message) => recorder.log(step, message),
      after: async (title, error, duration, step) => {
        await recorder.after(step, error);
        this.entries.push({
          title,
          start: Date.now() - duration,
          duration,
          error: error ? String((error as Error).message ?? error) : undefined,
          screenshot: recorder.lastScreenshot,
        });
      },
    };
    addStepListener(this.listener);
  }

  /** Adds a named marker, like Playwright's tracing.group(). */
  group(name: string): void {
    this.entries.push({ title: name, start: Date.now(), duration: 0, group: true });
  }

  groupEnd(): void {}

  /**
   * Stops recording and returns the trace: Playwright's trace.zip by default, or the HTML
   * viewer for a `.html` path / `format: 'html'`. Written to @p options.path if given.
   */
  async stop(options: TracingStopOptions = {}): Promise<Buffer> {
    if (!this.listener || !this.recorder) throw new Error('tracing has not been started');
    removeStepListener(this.listener);
    this.listener = undefined;
    const recorder = this.recorder;
    this.recorder = undefined;
    const output = this.app.output();
    if (output) recorder.stdout(output);
    const format = options.format ?? (options.path?.toLowerCase().endsWith('.html') ? 'html' : 'zip');
    const data = format === 'html' ? Buffer.from(this.render(recorder)) : await recorder.toZip();
    if (options.path) {
      await mkdir(dirname(options.path), { recursive: true });
      await writeFile(options.path, data);
    }
    return data;
  }

  private render(recorder: PlaywrightTraceRecorder): string {
    const title = escapeHtml(this.options.title ?? `Trace of ${this.app.info.appName} (pid ${this.app.pid})`);
    const rows = this.entries
      .map((e, i) => {
        const t = ((e.start - this.startedAt) / 1000).toFixed(2);
        const cls = e.group ? 'group' : e.error ? 'failed' : 'passed';
        return `<li class="${cls}" data-i="${i}"><span class="t">${t}s</span><span class="n">${escapeHtml(e.title)}</span><span class="d">${e.group ? '' : `${e.duration} ms`}</span></li>`;
      })
      .join('\n');
    const data = JSON.stringify(
      this.entries.map((e) => ({ s: e.screenshot ? recorder.dataUrl(e.screenshot) : null, e: e.error ?? null, t: e.title })),
    );
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
:root { color-scheme: light dark; --fg:#1f2328; --bg:#fff; --muted:#59636e; --sel:#ddf4ff; --bad:#cf222e; --ok:#1a7f37; --line:#d1d9e0; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --bg:#0d1117; --muted:#9198a1; --sel:#1f3a5a; --bad:#f85149; --ok:#3fb950; --line:#30363d; } }
body { margin:0; font:13px system-ui,sans-serif; color:var(--fg); background:var(--bg); display:flex; height:100vh; }
#list { width:42%; min-width:280px; overflow:auto; border-right:1px solid var(--line); margin:0; padding:0; list-style:none; }
h1 { font-size:14px; margin:0; padding:10px 12px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); }
li { display:flex; gap:8px; padding:6px 12px; cursor:pointer; border-bottom:1px solid var(--line); }
li:hover, li.sel { background:var(--sel); }
li .t { color:var(--muted); width:52px; flex:none; font-variant-numeric:tabular-nums; }
li .n { flex:1; word-break:break-all; font-family:ui-monospace,monospace; font-size:12px; }
li .d { color:var(--muted); flex:none; }
li.failed .n { color:var(--bad); } li.passed .n::before { content:"✓ "; color:var(--ok); } li.failed .n::before { content:"✗ "; }
li.group .n { font-weight:600; font-family:inherit; }
#detail { flex:1; overflow:auto; padding:12px; }
#detail img { max-width:100%; border:1px solid var(--line); }
#detail pre { white-space:pre-wrap; color:var(--bad); }
@media (max-width:700px) { body { flex-direction:column; } #list { width:auto; height:45vh; border-right:0; border-bottom:1px solid var(--line); } }
</style></head>
<body><ul id="list"><h1>${title}</h1>
${rows}
</ul><div id="detail"></div>
<script>
const data = ${data.replace(/</g, '\\u003c')};
const detail = document.getElementById('detail');
function show(i) {
  document.querySelectorAll('li').forEach((li) => li.classList.toggle('sel', +li.dataset.i === i));
  const d = data[i];
  let shot = d.s; for (let j = i; !shot && j >= 0; --j) shot = data[j].s;
  detail.innerHTML = '<h2></h2>' + (d.e ? '<pre></pre>' : '') + (shot ? '<img alt="windows after this action">' : '<p>No screenshot</p>');
  detail.querySelector('h2').textContent = d.t;
  if (d.e) detail.querySelector('pre').textContent = d.e;
  if (shot) detail.querySelector('img').src = shot;
}
document.getElementById('list').addEventListener('click', (ev) => { const li = ev.target.closest('li'); if (li) show(+li.dataset.i); });
document.addEventListener('keydown', (ev) => {
  const cur = document.querySelector('li.sel'); const i = cur ? +cur.dataset.i : -1;
  if (ev.key === 'ArrowDown' && i < data.length - 1) show(i + 1);
  if (ev.key === 'ArrowUp' && i > 0) show(i - 1);
});
const firstError = data.findIndex((d) => d.e); show(firstError >= 0 ? firstError : data.length - 1);
</script></body></html>
`;
  }
}
