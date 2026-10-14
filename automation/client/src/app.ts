// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { renderAriaSnapshot, type AriaNode } from './aria';
import { CodeRecorder, type RecordedAction } from './codegen';
import { Connection } from './connection';
import { Dialog, FileChooser, findDialogs, isFileDialog } from './dialogs';
import { Keyboard, Mouse, Touchscreen } from './input';
import { Inspector, type InspectorOptions } from './inspector';
import { step } from './instrumentation';
import { Locator, serializeArg } from './locator';
import {
  call,
  labelSelector,
  propertySelector,
  roleSelector,
  textSelector,
  type AriaRole,
  type ByRoleOptions,
} from './selectors';
import { Tracing } from './tracing';
import type { ElementInfo, ElementRef, ScreenshotOptions, TimeoutOptions } from './types';
import { Video, type VideoOptions } from './video';
import { poll, sleep } from './wait';

export interface AppScreenshotOptions extends ScreenshotOptions {
  /** All windows composed into one image (like a full-page screenshot), with title bars. */
  allWindows?: boolean;
  /** Keep the text cursor steady instead of blinking (default 'initial': untouched). */
  caret?: 'hide' | 'initial';
}

type DialogHandler = (dialog: Dialog) => unknown;

export interface AppInfo {
  protocolVersion: number;
  pid: number;
  appName: string;
  qtVersion: string;
  platform: string;
}

export interface OwnedProcess {
  /** The GammaRay launcher process (parent of the application). */
  launcher: ChildProcess;
  /** Combined stdout/stderr of launcher and application so far. */
  output: () => string;
}

/** A connected Qt application. */
export class QtApp {
  /** Default timeout for actions, waits and assertions, in milliseconds. */
  defaultTimeout = 5_000;
  /** Delay after every action in milliseconds (Playwright's slowMo). */
  slowMo = 0;
  /** Timeout of expect() assertions; defaults to defaultTimeout. */
  expectTimeout: number | undefined;
  /** Property used by getByTestId() (Playwright: selectors.setTestIdAttribute). */
  testIdAttribute = 'objectName';
  /** Coordinate-level input, in global (screen) coordinates. */
  readonly mouse: Mouse;
  readonly keyboard: Keyboard;
  readonly touchscreen: Touchscreen;
  /** Records actions, errors and screenshots into an HTML trace. */
  readonly tracing: Tracing;
  private dialogHandlers = new Set<DialogHandler>();
  private dialogWatcher: Promise<void> | undefined;
  private closed = false;
  private recordedVideo: Video | null = null;
  private inspectorInstance: Promise<Inspector> | undefined;
  private videos = new Set<Video>();

  constructor(
    readonly connection: Connection,
    readonly info: AppInfo,
    private readonly owned?: OwnedProcess,
  ) {
    this.mouse = new Mouse(this);
    this.keyboard = new Keyboard(this);
    this.touchscreen = new Touchscreen(this);
    this.tracing = new Tracing(this);
  }

  toString(): string {
    return `app(${this.info.appName})`;
  }

  /** Process id of the application. */
  get pid(): number {
    return this.info.pid;
  }

  /** Captured stdout/stderr of the application (only for launched apps). */
  output(): string {
    return this.owned?.output() ?? '';
  }

  setDefaultTimeout(ms: number): void {
    this.defaultTimeout = ms;
  }

  /** A lazy locator for @p selector; see Locator for the selector syntax. */
  locator(selector: string): Locator {
    return new Locator(this, selector);
  }

  /** Elements whose text matches: case-insensitive substring, or exact with `exact: true`. */
  getByText(text: string | RegExp, options: { exact?: boolean } = {}): Locator {
    return new Locator(this, textSelector(text, options.exact), undefined, call('getByText', text, options));
  }

  /** Elements by accessibility role and name, like Playwright's getByRole. */
  getByRole(role: AriaRole | string, options: ByRoleOptions = {}): Locator {
    return new Locator(this, roleSelector(role, options), undefined, call('getByRole', role, options));
  }

  /** Inputs by their label (QLabel buddy / form label, Accessible.name or the control's own text). */
  getByLabel(text: string | RegExp, options: { exact?: boolean } = {}): Locator {
    return new Locator(this, labelSelector(text, options.exact), undefined, call('getByLabel', text, options));
  }

  /** Inputs by placeholder text. */
  getByPlaceholder(text: string | RegExp, options: { exact?: boolean } = {}): Locator {
    return new Locator(this, propertySelector('placeholderText', text, options.exact), undefined, call('getByPlaceholder', text, options));
  }

  /** Elements by tooltip (toolTip property). */
  getByTitle(text: string | RegExp, options: { exact?: boolean } = {}): Locator {
    return new Locator(this, propertySelector('toolTip', text, options.exact), undefined, call('getByTitle', text, options));
  }

  /** Elements by test id, i.e. by the testIdAttribute property (default objectName). */
  getByTestId(testId: string | RegExp): Locator {
    return new Locator(this, propertySelector(this.testIdAttribute, testId, true), undefined, call('getByTestId', testId));
  }

  /** Changes the property getByTestId() matches (Playwright: selectors.setTestIdAttribute). */
  setTestIdAttribute(property: string): void {
    this.testIdAttribute = property;
  }

  /**
   * Runs @p fn inside the application (in a JavaScript engine with `qApp` bound to the
   * QCoreApplication) and returns its JSON-converted result, like page.evaluate().
   */
  async evaluate<R = any, Arg = unknown>(fn: string | ((arg: Arg) => R), arg?: Arg): Promise<R> {
    return step('app.evaluate', async () => {
      const r = await this.connection.call<{ value: R }>('evaluate', { function: fn.toString(), arg: await serializeArg(arg) });
      return r.value;
    });
  }

  /**
   * Starts recording the interactions with the application (real user input as well as
   * input from this API) as test code, like Playwright's codegen.
   */
  async startCodegen(onChange?: (actions: RecordedAction[]) => void): Promise<CodeRecorder> {
    return CodeRecorder.start(this, onChange);
  }

  /**
   * Like page.pause(): opens the inspector (a local web page: live view, pick locator,
   * locator playground, step over, recording) and waits until Resume is clicked there or
   * Enter is pressed in the terminal. Does nothing on CI (unless QTPW_DEBUG is set).
   */
  async pause(): Promise<void> {
    if (process.env.CI && !process.env.QTPW_DEBUG) {
      process.stderr.write('app.pause(): not pausing on CI\n');
      return;
    }
    await (await this.inspector()).pause();
  }

  /** The inspector for this application, started on first use (see pause()). */
  async inspector(options: InspectorOptions = {}): Promise<Inspector> {
    this.inspectorInstance ??= Inspector.start(this, options);
    return this.inspectorInstance;
  }

  /** Removes the highlight drawn by Locator.highlight(). */
  async hideHighlight(): Promise<void> {
    await this.connection.call('hideHighlight', {});
  }

  /** Accessibility tree of all windows as YAML (Playwright's ARIA snapshot format). */
  async ariaSnapshot(): Promise<string> {
    const r = await this.connection.call<{ nodes: AriaNode[] }>('ariaSnapshot', {});
    return renderAriaSnapshot(r.nodes);
  }

  /** Element by objectName or QML id. */
  getById(id: string): Locator {
    return new Locator(this, `#${JSON.stringify(id)}`, undefined, call('getById', id));
  }

  /** Visible top-level windows. */
  async windows(): Promise<ElementInfo[]> {
    return (await this.connection.call<{ elements: ElementInfo[] }>('windows')).elements;
  }

  /** PNG screenshot of the focused (or first) window, or of all windows with `allWindows`. */
  async screenshot(options: AppScreenshotOptions = {}): Promise<Buffer> {
    const buf = options.allWindows
      ? Buffer.from((await this.connection.call<{ image: string }>('screenshotAll', { cursor: false })).image, 'base64')
      : Buffer.from((await this.connection.call<{ png: string }>('screenshot', { caret: options.caret })).png, 'base64');
    if (options.path) await writeFile(options.path, buf);
    return buf;
  }

  /** PNG screenshots of all visible top-level windows. */
  async screenshotAllWindows(): Promise<{ window: ElementInfo; png: Buffer }[]> {
    const result: { window: ElementInfo; png: Buffer }[] = [];
    for (const w of await this.windows()) {
      try {
        const r = await this.connection.call<{ png: string }>('screenshot', { handle: w.handle, window: true });
        result.push({ window: w, png: Buffer.from(r.png, 'base64') });
      } catch {
        // window went away or cannot be grabbed; skip it
      }
    }
    return result;
  }

  /** Presses a key in the focused window, e.g. "Escape" or "Control+Q". */
  async press(key: string): Promise<void> {
    await step(`app.press(${JSON.stringify(key)})`, () => this.connection.call('press', { key }));
    if (this.slowMo) await sleep(this.slowMo);
  }

  /** Types text into the focused element. */
  async type(text: string): Promise<void> {
    await step(`app.type`, () => this.connection.call('type', { text }));
    if (this.slowMo) await sleep(this.slowMo);
  }

  /** Resolves once all previously requested input has been delivered to the application. */
  async sync(): Promise<void> {
    await this.connection.call('sync');
  }

  /**
   * Subscribes to object creation/destruction notifications.
   * @returns a function that unsubscribes.
   */
  async onObjectCreated(callback: (elements: ElementRef[]) => void): Promise<() => Promise<void>> {
    const listener = (params: { elements: ElementRef[] }) => callback(params.elements);
    this.connection.on('objectsCreated', listener);
    await this.connection.call('subscribe', { events: ['objectCreated'] });
    return async () => {
      this.connection.off('objectsCreated', listener);
      if (this.connection.listenerCount('objectsCreated') === 0)
        await this.connection.call('subscribe', { events: ['objectCreated'], enabled: false });
    };
  }

  async onObjectDestroyed(callback: (handles: number[]) => void): Promise<() => Promise<void>> {
    const listener = (params: { handles: number[] }) => callback(params.handles);
    this.connection.on('objectsDestroyed', listener);
    await this.connection.call('subscribe', { events: ['objectDestroyed'] });
    return async () => {
      this.connection.off('objectsDestroyed', listener);
      if (this.connection.listenerCount('objectsDestroyed') === 0)
        await this.connection.call('subscribe', { events: ['objectDestroyed'], enabled: false });
    };
  }

  /**
   * Waits until an object matching @p selector gets created (or already exists).
   * Uses creation events instead of busy polling.
   */
  async waitForObject(selector: string, options: TimeoutOptions = {}): Promise<Locator> {
    const locator = this.locator(selector);
    let changed = true;
    const unsubscribe = await this.onObjectCreated(() => (changed = true));
    try {
      await poll(`waitForObject(${JSON.stringify(selector)})`, options.timeout ?? this.defaultTimeout, async () => {
        if (!changed) return { done: false, log: `waiting for ${locator}` };
        changed = false;
        return { done: (await locator.count()) > 0, log: `waiting for ${locator}` };
      });
    } finally {
      await unsubscribe().catch(() => undefined);
    }
    return locator;
  }

  /**
   * The video recorded because of the `recordVideo` launch option (like Playwright's
   * `page.video()`), or null. The file is complete once the app is closed.
   */
  video(): Video | null {
    return this.recordedVideo;
  }

  /**
   * Starts recording the application's windows into @p path (.mp4, .webm, .mkv, .mov, .gif).
   * Call `stop()` on the result, or close the app, to finalize the file.
   */
  async startVideo(path: string, options: VideoOptions = {}): Promise<Video> {
    const video = await Video.start(this.connection, path, options);
    this.videos.add(video);
    return video;
  }

  /** @internal used by launch() for the recordVideo option */
  setRecordedVideo(video: Video): void {
    this.recordedVideo = video;
    this.videos.add(video);
  }

  /** Waits for a dialog (QDialog/QMessageBox window or Qt Quick Dialog) to be shown. */
  async waitForDialog(options: TimeoutOptions & { predicate?: (d: Dialog) => boolean | Promise<boolean> } = {}): Promise<Dialog> {
    return poll('waitForDialog', options.timeout ?? this.defaultTimeout, async () => {
      for (const info of await findDialogs(this)) {
        if (isFileDialog(info)) continue;
        const dialog = new Dialog(this, info);
        if (!options.predicate || (await options.predicate(dialog))) return { done: true, value: dialog };
      }
      return { done: false, log: 'waiting for a dialog to be shown' };
    });
  }

  /** Waits for a file dialog (QFileDialog or Qt Quick FileDialog) to be shown. */
  async waitForFileChooser(options: TimeoutOptions = {}): Promise<FileChooser> {
    return poll('waitForFileChooser', options.timeout ?? this.defaultTimeout, async () => {
      const found = (await findDialogs(this)).find(isFileDialog);
      return found ? { done: true, value: new FileChooser(this, found) } : { done: false, log: 'waiting for a file dialog' };
    });
  }

  /**
   * Like page.on('dialog'): calls @p handler for every dialog that is shown while registered.
   * The handler must accept or dismiss it (Qt dialogs are not dismissed automatically).
   */
  on(event: 'dialog', handler: DialogHandler): this;
  on(event: 'close', handler: () => void): this;
  on(event: 'dialog' | 'close', handler: DialogHandler | (() => void)): this {
    if (event === 'close') {
      this.connection.on('close', handler as () => void);
      return this;
    }
    this.dialogHandlers.add(handler as DialogHandler);
    this.dialogWatcher ??= this.watchDialogs();
    return this;
  }

  off(event: 'dialog' | 'close', handler: DialogHandler | (() => void)): this {
    if (event === 'close') this.connection.off('close', handler as () => void);
    else this.dialogHandlers.delete(handler as DialogHandler);
    return this;
  }

  private async watchDialogs(): Promise<void> {
    const seen = new Set<number>();
    try {
      while (this.dialogHandlers.size && !this.connection.isClosed) {
        const current = new Set<number>();
        for (const info of await findDialogs(this)) {
          if (isFileDialog(info)) continue;
          current.add(info.handle);
          if (seen.has(info.handle)) continue;
          seen.add(info.handle);
          const dialog = new Dialog(this, info);
          for (const h of [...this.dialogHandlers]) await h(dialog);
        }
        // a dialog shown again (e.g. QDialog reused) is reported again
        for (const h of seen) if (!current.has(h)) seen.delete(h);
        await sleep(50);
      }
    } catch {
      // connection closed
    } finally {
      this.dialogWatcher = undefined;
    }
  }

  /** Waits for an event, like page.waitForEvent(). */
  async waitForEvent(event: 'dialog', options?: TimeoutOptions & { predicate?: (d: Dialog) => boolean | Promise<boolean> }): Promise<Dialog>;
  async waitForEvent(event: 'filechooser', options?: TimeoutOptions): Promise<FileChooser>;
  async waitForEvent(event: 'objectcreated', options?: TimeoutOptions & { predicate?: (e: ElementRef) => boolean }): Promise<ElementRef>;
  async waitForEvent(event: 'close', options?: TimeoutOptions): Promise<void>;
  async waitForEvent(event: string, options: TimeoutOptions & { predicate?: (x: any) => any } = {}): Promise<unknown> {
    const timeout = options.timeout ?? this.defaultTimeout;
    switch (event) {
      case 'dialog':
        return this.waitForDialog(options);
      case 'filechooser':
        return this.waitForFileChooser(options);
      case 'close':
        if (this.connection.isClosed) return;
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`waitForEvent('close'): Timeout ${timeout}ms exceeded.`)), timeout);
          this.connection.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      case 'objectcreated': {
        let found: ElementRef | undefined;
        const stop = await this.onObjectCreated((els) => {
          found ??= els.find((e) => !options.predicate || options.predicate(e));
        });
        try {
          return await poll("waitForEvent('objectcreated')", timeout, async () => ({ done: !!found, value: found }));
        } finally {
          await stop().catch(() => undefined);
        }
      }
      default:
        throw new Error(`unknown event "${event}"`);
    }
  }

  /** Whether the application process is still running (launched apps only). */
  isRunning(): boolean {
    if (!this.owned) return !this.connection.isClosed;
    const l = this.owned.launcher;
    return l.exitCode === null && l.signalCode === null;
  }

  /**
   * Disconnects; for launched applications also terminates the application.
   * Attached applications keep running.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.inspectorInstance?.then((i) => i.close()).catch(() => undefined);
    // finalize recordings while the application can still deliver the last frames
    const results = await Promise.allSettled([...this.videos].map((v) => v.stop()));
    this.connection.close();
    if (!this.owned) return;
    const launcher = this.owned.launcher;
    const exited = new Promise<void>((resolve) => {
      if (launcher.exitCode !== null || launcher.signalCode !== null) resolve();
      else launcher.once('exit', () => resolve());
    });
    // terminating the application ends the launcher as well
    trySignal(this.info.pid, 'SIGTERM');
    if (!(await Promise.race([exited.then(() => true), sleep(3_000).then(() => false)]))) {
      trySignal(this.info.pid, 'SIGKILL');
      launcher.kill('SIGKILL');
      await exited;
    }
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed) throw failed.reason;
  }
}

function trySignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}
