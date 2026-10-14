// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

/** Runs a reported step; passes the runner's id of the step to @p body, if it has one. */
type StepRunner = <T>(title: string, body: (stepId?: string) => Promise<T>) => Promise<T>;

/** A reported (top-level) API call. */
export interface StepInfo {
  /** Unique per process. */
  id: number;
  title: string;
  /** performance.now() when the call started. */
  startTime: number;
  /** Where the call was made from (the test code), innermost first. */
  stack: StackFrame[];
  /** The test runner's id of this step (with the @playwright/test integration). */
  stepId?: string;
}

export interface StackFrame {
  file: string;
  line: number;
  column: number;
  function?: string;
}

// frames inside qt-playwright itself (src/ or dist/) are not interesting for users
const OWN_DIR = __dirname;

/** The caller's stack, without qt-playwright and Node internals. */
function captureStack(): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of (new Error().stack ?? '').split('\n').slice(1)) {
    const m = line.match(/^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    const file = m[2].replace(/^file:\/\//, '');
    if (file.startsWith(OWN_DIR) || file.startsWith('node:') || file.includes('/node_modules/')) continue;
    frames.push({ file, line: Number(m[3]), column: Number(m[4]), function: m[1] || undefined });
  }
  return frames;
}

/** Where an action is about to deliver input: the element and the point, in global coordinates. */
export interface InputInfo {
  handle?: number;
  point?: { x: number; y: number };
}

/** Observes top-level API calls (used by tracing). */
export interface StepListener {
  before?(title: string, step: StepInfo): void | Promise<void>;
  after?(title: string, error: unknown, durationMs: number, step: StepInfo): void | Promise<void>;
  /** The call is about to send input (after auto-waiting succeeded). */
  input?(step: StepInfo, input: InputInfo): void | Promise<void>;
  /** A call log line (what auto-waiting is waiting for). */
  log?(step: StepInfo, message: string): void;
}

let runner: StepRunner | undefined;
const listeners = new Set<StepListener>();
let depth = 0;
let nextId = 1;
let current: StepInfo | undefined;

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
  const info: StepInfo = { id: nextId++, title, startTime: performance.now(), stack: listeners.size ? captureStack() : [] };
  const started = Date.now();
  current = info;
  let error: unknown;
  try {
    const run = async (stepId?: string) => {
      info.stepId = stepId;
      for (const l of [...listeners]) await l.before?.(title, info);
      return body();
    };
    return runner ? await runner(title, run) : await run();
  } catch (e) {
    error = e;
    throw e;
  } finally {
    --depth;
    for (const l of [...listeners]) await l.after?.(title, error, Date.now() - started, info);
    if (current === info) current = undefined;
  }
}

/** Whether anything observes input (so callers can skip computing it). */
export function wantsInput(): boolean {
  return !!current && [...listeners].some((l) => l.input);
}

/** Reports that the current call is about to send input (for trace input snapshots). */
export async function reportInput(input: InputInfo): Promise<void> {
  const info = current;
  if (!info) return;
  for (const l of [...listeners]) await l.input?.(info, input);
}

/** Adds a line to the current call's log. */
export function reportLog(message: string): void {
  const info = current;
  if (!info) return;
  for (const l of listeners) l.log?.(info, message);
}
