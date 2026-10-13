// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

type StepRunner = <T>(title: string, body: () => Promise<T>) => Promise<T>;

/** Observes top-level API calls (used by tracing). */
export interface StepListener {
  before?(title: string): void | Promise<void>;
  after?(title: string, error: unknown, durationMs: number): void | Promise<void>;
}

let runner: StepRunner | undefined;
const listeners = new Set<StepListener>();
let depth = 0;

/** Lets a test runner (e.g. the @playwright/test fixtures) report API calls as steps. */
export function setStepRunner(r: StepRunner | undefined): void {
  runner = r;
}

export function addStepListener(l: StepListener): void {
  listeners.add(l);
}

export function removeStepListener(l: StepListener): void {
  listeners.delete(l);
}

/** Runs @p body as a reported step; nested API calls are not reported separately. */
export async function step<T>(title: string, body: () => Promise<T>): Promise<T> {
  if (depth > 0 || (!runner && listeners.size === 0)) return body();
  ++depth;
  const started = Date.now();
  let error: unknown;
  try {
    for (const l of listeners) await l.before?.(title);
    return runner ? await runner(title, body) : await body();
  } catch (e) {
    error = e;
    throw e;
  } finally {
    --depth;
    for (const l of [...listeners]) await l.after?.(title, error, Date.now() - started);
  }
}
