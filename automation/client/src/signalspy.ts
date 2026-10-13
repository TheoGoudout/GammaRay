// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import type { QtApp } from './app';
import { step } from './instrumentation';
import type { TimeoutOptions } from './types';
import { poll } from './wait';

/**
 * Records emissions of one signal inside the application (like QSignalSpy).
 *
 *   const spy = await window.spy('loggedIn');
 *   await loginButton.click();
 *   const [user] = await spy.wait();
 */
export class SignalSpy {
  private consumed = 0;

  constructor(
    private readonly app: QtApp,
    readonly id: number,
    readonly description: string,
  ) {}

  toString(): string {
    return `spy(${this.description})`;
  }

  /** Arguments of every emission so far. */
  async emissions(): Promise<unknown[][]> {
    const r = await this.app.connection.call<{ emissions: unknown[][] }>('spyEvents', { spyId: this.id });
    return r.emissions;
  }

  async count(): Promise<number> {
    return (await this.emissions()).length;
  }

  /**
   * Resolves with the arguments of the next emission not yet returned by wait()
   * (which may already have happened).
   */
  async wait(options: TimeoutOptions = {}): Promise<unknown[]> {
    return step(`${this}.wait`, () =>
      poll(`${this}.wait`, options.timeout ?? this.app.defaultTimeout, async () => {
        const all = await this.emissions();
        if (all.length > this.consumed) return { done: true, value: all[this.consumed++] };
        return { done: false, log: `waiting for emission #${this.consumed + 1} (${all.length} so far)` };
      }),
    );
  }

  /** Forgets recorded emissions. */
  async clear(): Promise<void> {
    await this.app.connection.call('spyEvents', { spyId: this.id, clear: true });
    this.consumed = 0;
  }

  async dispose(): Promise<void> {
    await this.app.connection.call('unspy', { spyId: this.id });
  }
}
