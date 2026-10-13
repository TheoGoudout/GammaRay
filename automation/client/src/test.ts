// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * @playwright/test integration:
 *
 *   // playwright.config.ts
 *   export default defineConfig({ use: { qtApp: { executable: './build/myapp' } } });
 *
 *   // login.spec.ts
 *   import { test, expect } from 'qt-playwright/test';
 *   test('login', async ({ app }) => {
 *     await app.locator('#user').fill('admin');
 *     await expect(app.locator('#status')).toHaveText('Welcome');
 *   });
 */

import { test as base, expect as pwExpect, type Expect } from '@playwright/test';
import type { QtApp } from './app';
import { expect as qtExpect, isQtSubject, LocatorAssertions, SignalSpyAssertions } from './expect';
import { setStepRunner } from './instrumentation';
import { launch, type LaunchOptions } from './launcher';
import type { Locator } from './locator';
import type { SignalSpy } from './signalspy';

export interface QtAppOptions extends LaunchOptions {
  /** The application to launch. */
  executable: string;
  args?: string[];
}

export type ScreenshotMode = 'off' | 'on' | 'only-on-failure';

export interface QtFixtures {
  /** The application under test, launched fresh for every test and closed afterwards. */
  app: QtApp;
}

export interface QtOptions {
  /** How to launch the application under test (set in playwright.config `use`). */
  qtApp: QtAppOptions | undefined;
  /** Attach screenshots of all windows to the test report (default: only-on-failure). */
  qtScreenshot: ScreenshotMode;
}

export const test = base.extend<QtFixtures & QtOptions>({
  qtApp: [undefined, { option: true }],
  qtScreenshot: ['only-on-failure', { option: true }],

  app: async ({ qtApp, qtScreenshot }, use, testInfo) => {
    if (!qtApp?.executable) throw new Error('qt-playwright: set `use: { qtApp: { executable: ... } }` in playwright.config');
    const { executable, args, ...launchOptions } = qtApp;
    const actionTimeout = testInfo.project.use.actionTimeout;
    const app = await launch(executable, args ?? [], {
      defaultTimeout: actionTimeout || undefined,
      ...launchOptions,
    });
    setStepRunner((title, body) => base.step(title, body, { box: true }));
    try {
      await use(app);
    } finally {
      setStepRunner(undefined);
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (app.isRunning() && (qtScreenshot === 'on' || (qtScreenshot === 'only-on-failure' && failed))) {
        for (const { window, png } of await app.screenshotAllWindows().catch(() => [])) {
          const name = window.objectName || window.id || window.text || `window-${window.handle}`;
          await testInfo.attach(`screenshot-${name}.png`, { body: png, contentType: 'image/png' });
        }
      }
      if (failed && app.output()) await testInfo.attach('app-output.txt', { body: app.output(), contentType: 'text/plain' });
      await app.close();
    }
  },
});

export interface QtExpect extends Expect<{}> {
  (subject: Locator): LocatorAssertions;
  (subject: SignalSpy): SignalSpyAssertions;
}

/** Playwright's expect, extended with qt-playwright's assertions for Locators and SignalSpies. */
export const expect: QtExpect = Object.assign(
  (actual: unknown, ...rest: unknown[]) =>
    isQtSubject(actual) ? qtExpect(actual as any) : (pwExpect as any)(actual, ...rest),
  pwExpect,
) as unknown as QtExpect;

export * from './index';
