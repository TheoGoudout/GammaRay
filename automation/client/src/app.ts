// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { Connection } from './connection';
import { step } from './instrumentation';
import { Locator, textSelector } from './locator';
import type { ElementInfo, ElementRef, ScreenshotOptions, TimeoutOptions } from './types';
import { poll, sleep } from './wait';

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
  private closed = false;

  constructor(
    readonly connection: Connection,
    readonly info: AppInfo,
    private readonly owned?: OwnedProcess,
  ) {}

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

  /** Elements whose text matches (exact by default for strings). */
  getByText(text: string | RegExp, options: { exact?: boolean } = {}): Locator {
    return this.locator(textSelector(text, options.exact));
  }

  /** Element by objectName or QML id. */
  getById(id: string): Locator {
    return this.locator(`#${JSON.stringify(id)}`);
  }

  /** Visible top-level windows. */
  async windows(): Promise<ElementInfo[]> {
    return (await this.connection.call<{ elements: ElementInfo[] }>('windows')).elements;
  }

  /** PNG screenshot of the focused (or first) window. */
  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const r = await this.connection.call<{ png: string }>('screenshot', {});
    const buf = Buffer.from(r.png, 'base64');
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
  }

  /** Types text into the focused element. */
  async type(text: string): Promise<void> {
    await step(`app.type`, () => this.connection.call('type', { text }));
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
  }
}

function trySignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}
