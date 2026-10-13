// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

type StepRunner = <T>(title: string, body: () => Promise<T>) => Promise<T>;

let runner: StepRunner | undefined;
let depth = 0;

/** Lets a test runner (e.g. the @playwright/test fixtures) report API calls as steps. */
export function setStepRunner(r: StepRunner | undefined): void {
  runner = r;
}

/** Runs @p body as a reported step; nested API calls are not reported separately. */
export async function step<T>(title: string, body: () => Promise<T>): Promise<T> {
  if (!runner || depth > 0) return body();
  ++depth;
  try {
    return await runner(title, body);
  } finally {
    --depth;
  }
}
