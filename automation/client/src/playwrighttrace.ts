// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QtApp } from './app';
import type { InputInfo, StepInfo } from './instrumentation';
import { zip, type ZipEntry } from './zip';

/**
 * Writes traces in Playwright's own format (trace.zip, format version 10), so that
 * `npx playwright show-trace`, trace.playwright.dev and the HTML report's trace viewer open
 * them: actions with timing, call logs and errors, a screencast film strip, and "DOM"
 * snapshots before, during and after every action.
 *
 * Qt has no DOM; a snapshot is the screenshot of all windows with the element tree laid
 * over it as transparent, absolutely positioned elements carrying the ARIA role, accessible
 * name, test id and text. The viewer can therefore highlight the action's target and its
 * "Pick locator" tool suggests getByRole()/getByTestId()/getByText() locators that work
 * with qt-playwright.
 */

const PAGE_ID = 'page@qt';
const FRAME_ID = 'frame@qt';
const RESOURCE_HOST = 'https://qt-playwright.invalid';

interface SnapshotNode {
  handle: number;
  type: string;
  geometry?: { x: number; y: number; width: number; height: number };
  objectName?: string;
  id?: string;
  text?: string;
  role?: string;
  name?: string;
  description?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  selected?: boolean;
  expanded?: boolean;
  level?: number;
  children?: SnapshotNode[];
}

type HtmlNode = string | [string, Record<string, string>, ...HtmlNode[]];

// roles that are not ARIA roles (or that would confuse locator generation)
const NO_ROLE = new Set(['text', 'generic', 'window', 'client', 'unknown', 'pane']);

export interface PlaywrightTraceOptions {
  title?: string;
  /** Screenshots for the film strip and the snapshots (default true). */
  screenshots?: boolean;
  /** DOM snapshots before/during/after actions (default true). */
  snapshots?: boolean;
  /** Scale of the screenshots (default 1). */
  scale?: number;
  /**
   * Also write the trace as it is recorded, as `<dir>/<prefix>.trace` / `.network` and
   * `<dir>/resources/`, which Playwright's UI mode shows while the test runs.
   */
  live?: { dir: string; prefix: string };
}

export class PlaywrightTraceRecorder {
  private readonly events: object[] = [];
  private readonly network: object[] = [];
  private readonly resources = new Map<string, Buffer>();
  private canvas = { x: 0, y: 0, width: 800, height: 600 };
  private lastFrame: { url: string; name: string; at: number } | undefined;
  private failed = false;

  constructor(
    private readonly app: QtApp,
    private readonly options: PlaywrightTraceOptions = {},
  ) {
    if (options.live) {
      mkdirSync(join(options.live.dir, 'resources'), { recursive: true });
      writeFileSync(join(options.live.dir, `${options.live.prefix}.trace`), '');
      writeFileSync(join(options.live.dir, `${options.live.prefix}.network`), '');
    }
    this.emit({
      type: 'context-options',
      version: 10,
      origin: 'library',
      browserName: 'qt',
      platform: process.platform,
      playwrightVersion: 'qt-playwright',
      wallTime: Date.now(),
      monotonicTime: this.now(),
      sdkLanguage: 'javascript',
      title: options.title ?? `${app.info.appName} (pid ${app.pid})`,
      options: {},
      testIdAttributeName: 'data-testid',
      contextId: 'context@qt',
    });
    this.emit({ type: 'event', time: this.now(), class: 'BrowserContext', method: 'page', params: { pageId: PAGE_ID } });
  }

  // Playwright's monotonic clock, so actions line up with the test runner's own trace
  private now(): number {
    return Math.floor(performance.now() * 1e3) / 1e3;
  }

  private callId(step: StepInfo): string {
    // the test runner's step id: the viewer merges our action with the runner's step
    return step.stepId ?? `call@${step.id}`;
  }

  private emit(event: object): void {
    this.events.push(event);
    if (this.options.live) appendFileSync(join(this.options.live.dir, `${this.options.live.prefix}.trace`), JSON.stringify(event) + '\n');
  }

  private emitNetwork(event: object): void {
    this.network.push(event);
    if (this.options.live) appendFileSync(join(this.options.live.dir, `${this.options.live.prefix}.network`), JSON.stringify(event) + '\n');
  }

  async start(): Promise<void> {
    await this.snapshot(undefined, undefined);
  }

  async before(step: StepInfo): Promise<void> {
    const { cls, method, selector } = parseTitle(step.title);
    this.emit({
      type: 'before',
      callId: this.callId(step),
      startTime: this.now(),
      title: step.title,
      class: cls,
      method,
      params: selector ? { selector } : {},
      pageId: PAGE_ID,
      // the viewer's Source tab shows the test line of each action
      stack: step.stack.length ? step.stack : undefined,
    });
    await this.snapshot(step, 'before');
  }

  async input(step: StepInfo, input: InputInfo): Promise<void> {
    const point = input.point ? this.toCanvas(input.point) : undefined;
    this.emit({ type: 'input', callId: this.callId(step), point });
    await this.snapshot(step, 'action', input.handle, point);
  }

  log(step: StepInfo, message: string): void {
    this.emit({ type: 'log', callId: this.callId(step), time: this.now(), message });
  }

  async after(step: StepInfo, error: unknown): Promise<void> {
    await this.snapshot(step, 'after');
    const err = error as Error | undefined;
    this.emit({
      type: 'after',
      callId: this.callId(step),
      endTime: this.now(),
      error: err ? { message: String(err.message ?? err), stack: err.stack } : undefined,
      result: undefined,
      attachments: [],
    });
  }

  /** Free-form output of the application (stdout lines). */
  stdout(text: string): void {
    if (text) this.emit({ type: 'stdout', timestamp: this.now(), text });
  }

  /** Resource name of the latest screenshot. */
  get lastScreenshot(): string | undefined {
    return this.lastFrame?.name;
  }

  /** A recorded screenshot as a data: URL. */
  dataUrl(resource: string): string | undefined {
    const data = this.resources.get(resource);
    return data ? `data:image/jpeg;base64,${data.toString('base64')}` : undefined;
  }

  /** The trace.zip contents. */
  async toZip(): Promise<Buffer> {
    const entries: ZipEntry[] = [
      { name: 'trace.trace', data: Buffer.from(this.events.map((e) => JSON.stringify(e)).join('\n') + '\n') },
      { name: 'trace.network', data: Buffer.from(this.network.map((e) => JSON.stringify(e)).join('\n') + '\n') },
    ];
    for (const [name, data] of this.resources) entries.push({ name: `resources/${name}`, data, compress: false });
    return zip(entries);
  }

  private toCanvas(p: { x: number; y: number }) {
    return { x: Math.round(p.x - this.canvas.x), y: Math.round(p.y - this.canvas.y) };
  }

  private addResource(data: Buffer, ext: string): string {
    const name = `${createHash('sha1').update(data).digest('hex')}.${ext}`;
    if (this.options.live && !this.resources.has(name)) writeFileSync(join(this.options.live.dir, 'resources', name), data);
    this.resources.set(name, data);
    return name;
  }

  /** Screenshot (film strip frame + network resource for snapshots); deduplicated. */
  private async frame(): Promise<string | undefined> {
    if (this.options.screenshots === false) return undefined;
    const r = await this.app.connection.call<{ image: string; width: number; height: number; canvas?: SnapshotNode['geometry'] }>(
      'screenshotAll',
      { scale: this.options.scale ?? 1, format: 'jpeg', quality: 70 },
    );
    if (r.canvas) this.canvas = r.canvas;
    const data = Buffer.from(r.image, 'base64');
    const name = this.addResource(data, 'jpeg');
    const url = `${RESOURCE_HOST}/frames/${name}`;
    const at = this.now();
    if (this.lastFrame?.url !== url) {
      this.emit({
        type: 'screencast-frame',
        pageId: PAGE_ID,
        file: `resources/${name}`,
        width: r.width,
        height: r.height,
        timestamp: at,
      });
      this.emitNetwork({
        type: 'resource-snapshot',
        snapshot: {
          _frameref: FRAME_ID,
          _monotonicTime: at - 0.001,
          request: { url, method: 'GET', headers: [], httpVersion: 'HTTP/1.1', cookies: [], queryString: [], headersSize: -1, bodySize: 0 },
          response: {
            status: 200,
            statusText: 'OK',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: [{ name: 'Content-Type', value: 'image/jpeg' }],
            content: { size: data.length, mimeType: 'image/jpeg', _file: `resources/${name}` },
            headersSize: -1,
            bodySize: data.length,
            redirectURL: '',
          },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
          startedDateTime: new Date().toISOString(),
          time: 0,
        },
      });
    }
    this.lastFrame = { url, name, at };
    return url;
  }

  private async snapshot(step: StepInfo | undefined, phase: 'before' | 'action' | 'after' | undefined, target?: number, point?: { x: number; y: number }) {
    if (this.failed || this.app.connection.isClosed) return;
    try {
      const image = await this.frame();
      if (this.options.snapshots === false || !step || !phase) return;
      const tree = await this.app.connection.call<{ windows: SnapshotNode[] }>('snapshotTree', { maxNodes: 4000 });
      const callId = this.callId(step);
      const body: HtmlNode[] = [];
      if (image)
        body.push(['IMG', { src: image, alt: '', style: `position:absolute;left:0;top:0;width:${this.canvas.width}px;height:${this.canvas.height}px` }]);
      for (const w of tree.windows) body.push(this.node(w, { x: this.canvas.x, y: this.canvas.y }, target === undefined ? undefined : { target, callId }));
      if (point) body.push(['X-QT-POINTER', { style: `position:absolute;left:${point.x - 4}px;top:${point.y - 4}px;width:8px;height:8px;border-radius:4px;background:rgba(255,0,0,.7)` }]);
      const css = [
        'html,body{margin:0;padding:0}',
        `body{position:relative;width:${this.canvas.width}px;height:${this.canvas.height}px;background:#3c3c3c;overflow:hidden;font:12px sans-serif}`,
        '.qt{position:absolute;box-sizing:border-box;color:transparent}',
        '.qt-text{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;white-space:pre;user-select:text}',
        '.qt:hover{outline:1px dashed rgba(64,160,255,.8)}',
      ].join('\n');
      const html: HtmlNode = ['HTML', {}, ['HEAD', {}, ['STYLE', {}, css]], ['BODY', {}, ...body]];
      this.emit({
        type: 'frame-snapshot',
        snapshot: {
          callId,
          phase,
          snapshotName: `${phase}@${callId}`,
          pageId: PAGE_ID,
          frameId: FRAME_ID,
          frameUrl: `qt://${this.app.info.appName}/`,
          doctype: 'html',
          html,
          viewport: { width: this.canvas.width, height: this.canvas.height },
          timestamp: this.now(),
          wallTime: Date.now(),
          collectionTime: 0,
          resourceOverrides: [],
          isMainFrame: true,
        },
      });
    } catch (e) {
      // the application may be gone (e.g. after close()); stop snapshotting
      if (this.app.connection.isClosed) this.failed = true;
      else throw e;
    }
  }

  private node(n: SnapshotNode, origin: { x: number; y: number }, mark: { target: number; callId: string } | undefined): HtmlNode {
    const g = n.geometry ?? { x: origin.x, y: origin.y, width: 0, height: 0 };
    const attrs: Record<string, string> = {
      class: 'qt',
      style: `left:${Math.round(g.x - origin.x)}px;top:${Math.round(g.y - origin.y)}px;width:${Math.round(g.width)}px;height:${Math.round(g.height)}px`,
      'data-qt-type': n.type,
    };
    if (n.objectName) attrs['data-testid'] = n.objectName;
    if (n.id) attrs.id = n.id;
    if (n.role && !NO_ROLE.has(n.role)) {
      attrs.role = n.role;
      if (n.name) attrs['aria-label'] = n.name;
    }
    if (n.description) attrs.title = n.description;
    if (n.checked !== undefined) attrs['aria-checked'] = String(n.checked);
    if (n.disabled) attrs['aria-disabled'] = 'true';
    if (n.selected) attrs['aria-selected'] = 'true';
    if (n.expanded !== undefined) attrs['aria-expanded'] = String(n.expanded);
    if (n.level) attrs['aria-level'] = String(n.level);
    if (n.value !== undefined && n.role === 'textbox') attrs['aria-valuetext'] = n.value;
    if (mark && n.handle === mark.target) attrs.__playwright_target__ = mark.callId;
    const children: HtmlNode[] = [];
    if (n.text && !n.children?.some((c) => c.text === n.text)) children.push(['SPAN', { class: 'qt-text' }, n.text]);
    for (const c of n.children ?? []) children.push(this.node(c, { x: g.x, y: g.y }, mark));
    return ['DIV', attrs, ...children];
  }
}

/** "getByRole('button').click" -> Locator.click with selector "getByRole('button')". */
function parseTitle(title: string): { cls: string; method: string; selector?: string } {
  if (title.startsWith('expect(')) return { cls: 'Expect', method: 'expect' };
  const m = title.match(/^(.*)\.([A-Za-z_$][\w$]*)$/);
  if (!m) return { cls: 'QtApp', method: title };
  const [, receiver, method] = m;
  if (['app', 'keyboard', 'mouse', 'touchscreen', 'tracing'].includes(receiver)) return { cls: 'QtApp', method: `${receiver}.${method}` };
  return { cls: 'Locator', method, selector: receiver };
}
