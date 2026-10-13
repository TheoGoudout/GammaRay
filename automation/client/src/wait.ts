// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { TimeoutError } from './errors';

/** Back-off between retries, like Playwright's. The last value repeats. */
const POLL_INTERVALS = [0, 20, 50, 100, 100, 250, 500];

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface PollResult<T> {
  done: boolean;
  value?: T;
  /** Human-readable reason why we are still waiting (shown on timeout). */
  log?: string;
}

/**
 * Re-runs @p attempt until it reports done or @p timeout ms have elapsed.
 * Errors thrown by @p attempt propagate immediately.
 */
export async function poll<T>(
  description: string,
  timeout: number,
  attempt: () => Promise<PollResult<T>>,
): Promise<T> {
  const deadline = Date.now() + timeout;
  const log: string[] = [];
  for (let i = 0; ; ++i) {
    const result = await attempt();
    if (result.done) return result.value as T;
    if (result.log && log[log.length - 1] !== result.log) log.push(result.log);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const details = log.length ? `\nCall log:\n${log.map((l) => `  - ${l}`).join('\n')}` : '';
      throw new TimeoutError(`${description}: Timeout ${timeout}ms exceeded.${details}`);
    }
    await sleep(Math.min(POLL_INTERVALS[Math.min(i, POLL_INTERVALS.length - 1)], remaining));
  }
}
