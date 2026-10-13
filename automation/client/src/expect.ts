// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { inspect, isDeepStrictEqual } from 'node:util';
import { QtApp } from './app';
import { matchesAriaTemplate, renderAriaSnapshot, type AriaNode } from './aria';
import { ErrorCode, QtError, TimeoutError } from './errors';
import { step } from './instrumentation';
import { Locator, type Actionability } from './locator';
import { SignalSpy } from './signalspy';
import type { ElementInfo, TimeoutOptions } from './types';
import { poll, sleep } from './wait';

export interface ScreenshotAssertionOptions extends TimeoutOptions {
  /** Elements to paint over (e.g. clocks, animations). */
  mask?: Locator[];
  maskColor?: string;
  /** Acceptable number / ratio of differing pixels and per-pixel color threshold (0..1). */
  maxDiffPixels?: number;
  maxDiffPixelRatio?: number;
  threshold?: number;
}

/** Compares a PNG against a stored baseline; throws on mismatch. Provided by the test runner integration. */
export type ScreenshotComparator = (png: Buffer, name: string | undefined, options: ScreenshotAssertionOptions) => void;

let screenshotComparator: ScreenshotComparator | undefined;

/** Installs the baseline comparison used by toHaveScreenshot() (qt-playwright/test does this). */
export function setScreenshotComparator(c: ScreenshotComparator | undefined): void {
  screenshotComparator = c;
}

/** Thrown when a retrying assertion does not pass within its timeout. */
export class ExpectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpectError';
  }
}

interface Check {
  pass: boolean;
  /** What was observed, for the failure message. */
  actual: unknown;
}

const NOT_FOUND = Symbol('element not found');

function show(v: unknown): string {
  if (v === NOT_FOUND) return '<element not found>';
  if (v instanceof RegExp) return String(v);
  return inspect(v, { depth: 4, breakLength: Infinity });
}

/** Runs @p evaluate with a missing element mapped to NOT_FOUND instead of an error. */
async function orNotFound<T>(locator: Locator, evaluate: (handle: number) => Promise<T>): Promise<T | typeof NOT_FOUND> {
  const elements = await locator.elements();
  if (elements.length === 0) return NOT_FOUND;
  if (elements.length > 1) {
    // reuse the locator's strict mode message
    await locator.handle({ timeout: 0 });
  }
  try {
    return await evaluate(elements[0].handle);
  } catch (e) {
    if (e instanceof QtError && e.code === ErrorCode.StaleHandle) return NOT_FOUND;
    throw e;
  }
}

function matchesText(actual: unknown, expected: string | RegExp, contains: boolean): boolean {
  if (typeof actual !== 'string') return false;
  if (expected instanceof RegExp) return expected.test(actual);
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return contains ? norm(actual).includes(norm(expected)) : norm(actual) === norm(expected);
}

abstract class BaseAssertions<T> {
  constructor(
    protected readonly subject: T,
    protected readonly isNot: boolean,
    protected readonly defaultTimeout: number,
  ) {}

  protected async retry(
    name: string,
    expected: unknown,
    options: TimeoutOptions,
    evaluate: () => Promise<Check>,
  ): Promise<void> {
    const timeout = options.timeout ?? this.defaultTimeout;
    const title = `expect(${this.subject})${this.isNot ? '.not' : ''}.${name}`;
    await step(title, async () => {
      let last: Check | undefined;
      try {
        await poll(title, timeout, async () => {
          last = await evaluate();
          return { done: last.pass !== this.isNot };
        });
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        const lines = [`${title}${expected === undefined ? '()' : `(${show(expected)})`} failed`, ''];
        if (expected !== undefined) lines.push(`Expected: ${this.isNot ? 'not ' : ''}${show(expected)}`);
        lines.push(`Received: ${last ? show(last.actual) : '<nothing>'}`);
        lines.push(`Timeout:  ${timeout}ms`);
        throw new ExpectError(lines.join('\n'));
      }
    });
  }
}

/** Waits for two identical consecutive screenshots, then compares with the baseline (retrying). */
async function assertScreenshot(
  title: string,
  timeout: number,
  take: (remaining: number) => Promise<Buffer>,
  name: string | undefined,
  options: ScreenshotAssertionOptions,
): Promise<void> {
  const comparator = screenshotComparator;
  if (!comparator) throw new Error(`${title}: toHaveScreenshot() needs the test runner integration (import from 'qt-playwright/test')`);
  await step(title, async () => {
    const deadline = Date.now() + timeout;
    let previous: Buffer | undefined;
    let lastError: unknown;
    for (;;) {
      const shot = await take(Math.max(0, deadline - Date.now()));
      if (previous && previous.equals(shot)) {
        try {
          comparator(shot, name, options);
          return;
        } catch (e) {
          lastError = e;
          // a missing baseline was just written: nothing to wait for
          if (/doesn't exist|writing actual/i.test(String((e as Error).message))) throw e;
        }
      }
      previous = shot;
      if (Date.now() >= deadline)
        throw lastError ?? new ExpectError(`${title} failed\n\nScreenshot did not become stable within ${timeout}ms`);
      await sleep(100);
    }
  });
}

function parseScreenshotArgs(a?: string | ScreenshotAssertionOptions, b?: ScreenshotAssertionOptions) {
  return typeof a === 'string' ? { name: a, options: b ?? {} } : { name: undefined, options: a ?? {} };
}

async function maskHandles(mask: Locator[] | undefined): Promise<number[]> {
  const handles: number[] = [];
  for (const m of mask ?? []) for (const e of await m.elements()) handles.push(e.handle);
  return handles;
}

export class LocatorAssertions extends BaseAssertions<Locator> {
  /** Negates the following assertion. */
  get not(): LocatorAssertions {
    return new LocatorAssertions(this.subject, !this.isNot, this.defaultTimeout);
  }

  private state(name: string, options: TimeoutOptions, read: (handle: number) => Promise<boolean>, missing: boolean) {
    return this.retry(name, undefined, options, async () => {
      const v = await orNotFound(this.subject, read);
      return { pass: v === NOT_FOUND ? missing : v, actual: v === NOT_FOUND ? NOT_FOUND : v };
    });
  }

  private async actionability(handle: number) {
    return this.subject.app.connection.call<Actionability>('actionability', {
      handle,
      checkHitTarget: false,
    });
  }

  private async info(handle: number): Promise<ElementInfo> {
    return this.subject.app.connection.call<ElementInfo>('describe', { handle });
  }

  /** Accessible name equals @p name (whitespace-normalized) or matches the RegExp. */
  async toHaveAccessibleName(name: string | RegExp, options: TimeoutOptions & { ignoreCase?: boolean } = {}): Promise<void> {
    await this.retry('toHaveAccessibleName', name, options, async () => {
      const v = await orNotFound(this.subject, async (h) => (await this.info(h)).accessibleName ?? '');
      const pass = typeof v === 'string' && (options.ignoreCase && typeof name === 'string'
        ? v.toLowerCase().trim() === name.toLowerCase().trim()
        : matchesText(v, name, false));
      return { pass, actual: v };
    });
  }

  async toHaveAccessibleDescription(description: string | RegExp, options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toHaveAccessibleDescription', description, options, async () => {
      const v = await orNotFound(this.subject, async (h) => (await this.info(h)).accessibleDescription ?? '');
      return { pass: matchesText(v, description, false), actual: v };
    });
  }

  /** ARIA role (derived from the Qt accessibility role), e.g. "button", "textbox". */
  async toHaveRole(role: string, options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toHaveRole', role, options, async () => {
      const v = await orNotFound(this.subject, async (h) => (await this.info(h)).role ?? '');
      return { pass: v === role, actual: v };
    });
  }

  /** objectName or QML id. */
  async toHaveId(id: string | RegExp, options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toHaveId', id, options, async () => {
      const v = await orNotFound(this.subject, (h) => this.info(h));
      const ids = v === NOT_FOUND ? [] : [v.objectName ?? '', v.id ?? ''];
      return { pass: ids.some((x) => matchesText(x, id, false) && x !== ''), actual: v === NOT_FOUND ? v : ids.filter(Boolean) };
    });
  }

  /** Qt adaptation of toHaveClass(): one of the element's type names (C++ classes, QML types). */
  async toHaveClass(type: string | RegExp, options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toHaveClass', type, options, async () => {
      const v = await orNotFound(this.subject, async (h) => (await this.info(h)).typeNames);
      const pass = v !== NOT_FOUND && v.some((t) => (type instanceof RegExp ? type.test(t) : t === type));
      return { pass, actual: v };
    });
  }

  /** An enabled input that is not read-only (or the opposite with editable: false). */
  async toBeEditable(options: TimeoutOptions & { editable?: boolean } = {}): Promise<void> {
    const want = options.editable ?? true;
    await this.retry('toBeEditable', want ? undefined : { editable: false }, options, async () => {
      const v = await orNotFound(this.subject, async (h) => (await this.actionability(h)).editable ?? -1);
      if (v === -1) throw new ExpectError(`expect(${this.subject}).toBeEditable(): element is not an input (no readOnly/editable property)`);
      return { pass: v !== NOT_FOUND && (v === 1) === want, actual: v === NOT_FOUND ? v : v === 1 ? 'editable' : 'read-only' };
    });
  }

  /** No text: an empty input, or an element without text in itself or its descendants. */
  async toBeEmpty(options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toBeEmpty', undefined, options, async () => {
      const v = await orNotFound(this.subject, async (h) => {
        const info = await this.info(h);
        const own = info.text ?? '';
        // inputs: only their value counts (not placeholder items inside them)
        if (own.trim() || (info.editable ?? -1) >= 0) return own;
        const inside = await this.subject.app.connection.call<{ elements: ElementInfo[] }>('query', {
          selector: 'text=/\\S/',
          scope: h,
          describe: true,
        });
        return inside.elements.map((e) => e.text).join(' ');
      });
      return { pass: v !== NOT_FOUND && !String(v).trim(), actual: v };
    });
  }

  /** At least @p ratio (default: any part) of the element is inside its window and scroll viewport. */
  async toBeInViewport(options: TimeoutOptions & { ratio?: number } = {}): Promise<void> {
    await this.retry('toBeInViewport', options.ratio !== undefined ? { ratio: options.ratio } : undefined, options, async () => {
      const v = await orNotFound(this.subject, async (h) => (await this.actionability(h)).viewportRatio ?? 0);
      const pass = v !== NOT_FOUND && (options.ratio !== undefined ? v >= options.ratio : v > 0);
      return { pass, actual: v === NOT_FOUND ? v : `visible ratio ${Number(v).toFixed(2)}` };
    });
  }

  /** Alias of toHaveProperty() for Playwright familiarity. */
  async toHaveJSProperty(name: string, value: unknown, options: TimeoutOptions = {}): Promise<void> {
    await this.toHaveProperty(name, value, options);
  }

  /** Qt adaptation of toHaveAttribute(): a Qt property, compared as text; without value, it must be truthy. */
  async toHaveAttribute(name: string, value?: string | RegExp, options: TimeoutOptions = {}): Promise<void> {
    await this.retry(`toHaveAttribute(${JSON.stringify(name)})`, value, options, async () => {
      const v = await orNotFound(this.subject, (h) => this.property(h, name).catch(() => undefined));
      if (v === NOT_FOUND) return { pass: false, actual: v };
      if (value === undefined) return { pass: v !== undefined && v !== null && v !== false && v !== '', actual: v };
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      return { pass: value instanceof RegExp ? value.test(text) : text === value, actual: v };
    });
  }

  /** Accessibility tree matches the template (Playwright ARIA snapshot syntax, partial matching). */
  async toMatchAriaSnapshot(expected: string, options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toMatchAriaSnapshot', expected, options, async () => {
      const v = await orNotFound(this.subject, async (h) => {
        const r = await this.subject.app.connection.call<{ nodes: AriaNode[] }>('ariaSnapshot', { handle: h });
        return r.nodes;
      });
      if (v === NOT_FOUND) return { pass: false, actual: v };
      return { pass: matchesAriaTemplate(expected, v), actual: renderAriaSnapshot(v) };
    });
  }

  /**
   * Compares a screenshot of the element with a baseline image (stored next to the test;
   * update with --update-snapshots). Waits for the rendering to be stable first.
   */
  async toHaveScreenshot(nameOrOptions?: string | ScreenshotAssertionOptions, maybeOptions?: ScreenshotAssertionOptions): Promise<void> {
    const { name, options } = parseScreenshotArgs(nameOrOptions, maybeOptions);
    const timeout = options.timeout ?? this.defaultTimeout;
    await assertScreenshot(`expect(${this.subject}).toHaveScreenshot`, timeout, async (remaining) => {
      const handle = await this.subject.handle({ timeout: remaining });
      const r = await this.subject.app.connection.call<{ png: string }>('screenshot', {
        handle,
        caret: 'hide',
        mask: await maskHandles(options.mask),
        maskColor: options.maskColor,
      });
      return Buffer.from(r.png, 'base64');
    }, name, options);
  }

  async toBeVisible(options: TimeoutOptions = {}): Promise<void> {
    await this.state('toBeVisible', options, async (h) => !!(await this.actionability(h)).visible, false);
  }

  async toBeHidden(options: TimeoutOptions = {}): Promise<void> {
    await this.state('toBeHidden', options, async (h) => !(await this.actionability(h)).visible, true);
  }

  async toBeEnabled(options: TimeoutOptions = {}): Promise<void> {
    await this.state('toBeEnabled', options, async (h) => !!(await this.actionability(h)).enabled, false);
  }

  async toBeDisabled(options: TimeoutOptions = {}): Promise<void> {
    await this.state('toBeDisabled', options, async (h) => !(await this.actionability(h)).enabled, false);
  }

  async toBeAttached(options: TimeoutOptions & { attached?: boolean } = {}): Promise<void> {
    const want = options.attached ?? true;
    await this.retry('toBeAttached', undefined, options, async () => {
      const n = await this.subject.count();
      return { pass: (n > 0) === want, actual: n > 0 ? 'attached' : 'detached' };
    });
  }

  async toBeChecked(options: TimeoutOptions & { checked?: boolean } = {}): Promise<void> {
    const want = options.checked ?? true;
    await this.retry('toBeChecked', want ? undefined : { checked: false }, options, async () => {
      const v = await orNotFound(this.subject, (h) => this.property(h, 'checked'));
      return { pass: v !== NOT_FOUND && !!v === want, actual: v === NOT_FOUND ? v : !!v };
    });
  }

  /** Has keyboard focus (QWidget::hasFocus / QQuickItem::activeFocus). */
  async toBeFocused(options: TimeoutOptions = {}): Promise<void> {
    await this.state(
      'toBeFocused',
      options,
      async (h) => {
        const props = await this.subject.app.connection.call<{ properties: Record<string, unknown> }>('getProperties', { handle: h });
        return !!(props.properties.activeFocus ?? props.properties.focus);
      },
      false,
    );
  }

  private async property(handle: number, name: string): Promise<unknown> {
    return (await this.subject.app.connection.call<{ value: unknown }>('getProperty', { handle, name })).value;
  }

  private async text(handle: number): Promise<string> {
    return (await this.subject.app.connection.call<{ value: string }>('text', { handle })).value;
  }

  /** Text equals @p expected (whitespace-normalized) or matches the RegExp. */
  async toHaveText(expected: string | RegExp, options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toHaveText', expected, options, async () => {
      const v = await orNotFound(this.subject, (h) => this.text(h));
      return { pass: matchesText(v, expected, false), actual: v };
    });
  }

  async toContainText(expected: string | RegExp, options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toContainText', expected, options, async () => {
      const v = await orNotFound(this.subject, (h) => this.text(h));
      return { pass: matchesText(v, expected, true), actual: v };
    });
  }

  /** Current text of an editable element. */
  async toHaveValue(expected: string | RegExp, options: TimeoutOptions = {}): Promise<void> {
    await this.toHaveText(expected, options);
  }

  /** Property @p name deep-equals @p value (or matches it, for a RegExp). */
  async toHaveProperty(name: string, value: unknown, options: TimeoutOptions = {}): Promise<void> {
    await this.retry(`toHaveProperty(${JSON.stringify(name)})`, value, options, async () => {
      const v = await orNotFound(this.subject, (h) => this.property(h, name));
      const pass =
        v !== NOT_FOUND && (value instanceof RegExp ? typeof v === 'string' && value.test(v) : isDeepStrictEqual(v, value));
      return { pass, actual: v };
    });
  }

  /** Exactly @p count elements match. */
  async toHaveCount(count: number, options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toHaveCount', count, options, async () => {
      const n = await this.subject.count();
      return { pass: n === count, actual: n };
    });
  }
}

export class SignalSpyAssertions extends BaseAssertions<SignalSpy> {
  get not(): SignalSpyAssertions {
    return new SignalSpyAssertions(this.subject, !this.isNot, this.defaultTimeout);
  }

  async toHaveBeenEmitted(options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toHaveBeenEmitted', undefined, options, async () => {
      const n = await this.subject.count();
      return { pass: n > 0, actual: `${n} emission(s)` };
    });
  }

  async toHaveBeenEmittedTimes(times: number, options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toHaveBeenEmittedTimes', times, options, async () => {
      const n = await this.subject.count();
      return { pass: n === times, actual: n };
    });
  }

  /** Some emission had exactly these arguments. */
  async toHaveBeenEmittedWith(args: unknown[], options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toHaveBeenEmittedWith', args, options, async () => {
      const all = await this.subject.emissions();
      return { pass: all.some((e) => isDeepStrictEqual(e, args)), actual: all };
    });
  }
}

/** Default timeout for assertions on spies (locators use their app's default timeout). */
export const expectDefaults = { timeout: 5_000 };

/**
 * Retrying assertions for Locators and SignalSpies: they re-check until the condition holds
 * or the timeout (default: the app's default timeout) expires.
 *
 *   await expect(app.locator('#status')).toHaveText('Welcome, admin!');
 *   await expect(app.locator('Button')).not.toBeVisible();
 */
export function expect(subject: Locator): LocatorAssertions;
export function expect(subject: SignalSpy): SignalSpyAssertions;
export function expect(subject: QtApp): AppAssertions;
export function expect(subject: Locator | SignalSpy | QtApp): LocatorAssertions | SignalSpyAssertions | AppAssertions {
  if (subject instanceof Locator)
    return new LocatorAssertions(subject, false, subject.app.expectTimeout ?? subject.app.defaultTimeout);
  if (subject instanceof QtApp) return new AppAssertions(subject, false, subject.expectTimeout ?? subject.defaultTimeout);
  if (subject instanceof SignalSpy) return new SignalSpyAssertions(subject, false, expectDefaults.timeout);
  throw new TypeError('qt-playwright expect() accepts a Locator, a SignalSpy or a QtApp');
}

export function isQtSubject(v: unknown): v is Locator | SignalSpy | QtApp {
  return v instanceof Locator || v instanceof SignalSpy || v instanceof QtApp;
}

/** Assertions on the whole application (all windows), like expect(page). */
export class AppAssertions extends BaseAssertions<QtApp> {
  get not(): AppAssertions {
    return new AppAssertions(this.subject, !this.isNot, this.defaultTimeout);
  }

  /** Some visible window has this title (or the focused window, with `focused: true`). */
  async toHaveTitle(title: string | RegExp, options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toHaveTitle', title, options, async () => {
      const titles = (await this.subject.windows()).map((w) => w.text ?? '');
      return { pass: titles.some((t) => matchesText(t, title, false)), actual: titles };
    });
  }

  async toMatchAriaSnapshot(expected: string, options: TimeoutOptions = {}): Promise<void> {
    await this.retry('toMatchAriaSnapshot', expected, options, async () => {
      const r = await this.subject.connection.call<{ nodes: AriaNode[] }>('ariaSnapshot', {});
      return { pass: matchesAriaTemplate(expected, r.nodes), actual: renderAriaSnapshot(r.nodes) };
    });
  }

  /** Compares all windows (composed into one image) with a baseline image. */
  async toHaveScreenshot(nameOrOptions?: string | ScreenshotAssertionOptions, maybeOptions?: ScreenshotAssertionOptions): Promise<void> {
    const { name, options } = parseScreenshotArgs(nameOrOptions, maybeOptions);
    const timeout = options.timeout ?? this.defaultTimeout;
    await assertScreenshot('expect(app).toHaveScreenshot', timeout, async () => {
      const r = await this.subject.connection.call<{ image: string }>('screenshotAll', { cursor: false, chrome: true });
      return Buffer.from(r.image, 'base64');
    }, name, options);
  }
}
