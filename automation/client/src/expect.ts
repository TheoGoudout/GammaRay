// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { inspect, isDeepStrictEqual } from 'node:util';
import { ErrorCode, QtError, TimeoutError } from './errors';
import { step } from './instrumentation';
import { Locator } from './locator';
import { SignalSpy } from './signalspy';
import type { TimeoutOptions } from './types';
import { poll } from './wait';

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
    return this.subject.app.connection.call<{ attached: boolean; visible?: boolean; enabled?: boolean }>('actionability', {
      handle,
      checkHitTarget: false,
    });
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
export function expect(subject: Locator | SignalSpy): LocatorAssertions | SignalSpyAssertions {
  if (subject instanceof Locator) return new LocatorAssertions(subject, false, subject.app.defaultTimeout);
  if (subject instanceof SignalSpy) return new SignalSpyAssertions(subject, false, expectDefaults.timeout);
  throw new TypeError('qt-playwright expect() accepts a Locator or a SignalSpy');
}

export function isQtSubject(v: unknown): v is Locator | SignalSpy {
  return v instanceof Locator || v instanceof SignalSpy;
}
