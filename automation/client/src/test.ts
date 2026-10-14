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

import { join } from 'node:path';
import { test as base, expect as pwExpect, type Expect } from '@playwright/test';
import type { QtApp } from './app';
import type { TracingStartOptions } from './tracing';
import {
  AppAssertions,
  expect as qtExpect,
  isQtSubject,
  LocatorAssertions,
  setScreenshotComparator,
  SignalSpyAssertions,
} from './expect';
import { setStepRunner } from './instrumentation';
import { launch, type LaunchOptions } from './launcher';
import type { Locator } from './locator';
import type { SignalSpy } from './signalspy';
import type { VideoOptions } from './video';

export interface QtAppOptions extends LaunchOptions {
  /** The application to launch. */
  executable: string;
  args?: string[];
}

export type ScreenshotMode = 'off' | 'on' | 'only-on-failure';
export type VideoMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
export type TraceMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry' | 'on-all-retries' | 'retain-on-first-failure';

export interface QtFixtures {
  /** The application under test, launched fresh for every test and closed afterwards. */
  app: QtApp;
}

export interface QtOptions {
  /** How to launch the application under test (set in playwright.config `use`). */
  qtApp: QtAppOptions | undefined;
  /** Attach screenshots of all windows to the test report (default: only-on-failure). */
  qtScreenshot: ScreenshotMode;
  /**
   * Record an mp4 of each test and attach it to the report. Defaults to Playwright's own
   * `video` option, so `use: { video: 'retain-on-failure' }` works as for browsers.
   */
  qtVideo: VideoMode | ({ mode: VideoMode } & VideoOptions) | undefined;
  /**
   * Record a trace (actions, call logs, errors, screenshots and element snapshots) and attach
   * it: Playwright's trace.zip, which the HTML report's trace viewer opens, or with
   * `format: 'html'` a self-contained HTML viewer. Defaults to Playwright's own `trace` option.
   */
  qtTrace: TraceMode | ({ mode: TraceMode; format?: 'zip' | 'html' } & TracingStartOptions) | undefined;
}

export const test = base.extend<QtFixtures & QtOptions>({
  qtApp: [undefined, { option: true }],
  qtScreenshot: ['only-on-failure', { option: true }],
  qtVideo: [undefined, { option: true }],
  qtTrace: [undefined, { option: true }],

  app: async ({ qtApp, qtScreenshot, qtVideo, video, qtTrace, trace }, use, testInfo) => {
    if (!qtApp?.executable) throw new Error('qt-playwright: set `use: { qtApp: { executable: ... } }` in playwright.config');
    const { executable, args, ...launchOptions } = qtApp;
    const actionTimeout = testInfo.project.use.actionTimeout;

    const videoSetting = qtVideo ?? video;
    const { mode: videoMode, ...videoOptions } =
      typeof videoSetting === 'string' ? { mode: videoSetting } : (videoSetting ?? { mode: 'off' as const });
    const recordVideo =
      videoMode === 'on' || videoMode === 'retain-on-failure' || (videoMode === 'on-first-retry' && testInfo.retry === 1);

    // QTPW_DEBUG=1: stepping in the inspector, like PWDEBUG=1 (no test timeout)
    if (process.env.QTPW_DEBUG) testInfo.setTimeout(0);
    const app = await launch(executable, args ?? [], {
      defaultTimeout: actionTimeout || undefined,
      ...launchOptions,
      recordVideo: recordVideo ? { ...videoOptions, dir: testInfo.outputPath('videos') } : launchOptions.recordVideo,
    });
    const traceSetting = (qtTrace ?? trace) as QtOptions['qtTrace'];
    // Playwright's trace option may carry runner-only fields (UI mode: { live, sources })
    type TraceObject = { mode: TraceMode; format?: 'zip' | 'html'; live?: boolean; sources?: boolean } & TracingStartOptions;
    const traceObject: TraceObject =
      typeof traceSetting === 'string' ? { mode: traceSetting } : ((traceSetting as TraceObject | undefined) ?? { mode: 'off' });
    const { mode: traceMode, format: traceFormat, live, sources: _sources, ...traceOptions } = traceObject;
    const recordTrace =
      traceMode === 'on' ||
      traceMode === 'retain-on-failure' ||
      (traceMode === 'on-first-retry' && testInfo.retry === 1) ||
      (traceMode === 'on-all-retries' && testInfo.retry > 0) ||
      (traceMode === 'retain-on-first-failure' && testInfo.retry === 0);
    // UI mode (trace: { live: true }) shows traces while the test runs: write ours next to
    // the runner's live trace, in the worker's artifacts directory, prefixed with the test id
    const liveDir = live ? join(testInfo.project.outputDir, `.playwright-artifacts-${testInfo.workerIndex}`, 'traces') : undefined;
    if (recordTrace)
      await app.tracing.start({
        title: testInfo.titlePath.join(' › '),
        ...traceOptions,
        live: liveDir ? { dir: liveDir, prefix: `${testInfo.testId}-qt` } : undefined,
      });

    // API calls are report steps; the step id lets traces merge them with the runner's steps
    setStepRunner((title, body) => base.step(title, (stepInfo) => body((stepInfo as { _stepId?: string })._stepId), { box: true }));
    setScreenshotComparator((png, name, options) => {
      const snapshotName = name
        ? name.endsWith('.png') ? name : `${name}.png`
        : `${testInfo.titlePath.slice(1).join('-')}-${++screenshotCounter}.png`.replace(/[^\w.-]+/g, '-');
      const { maxDiffPixels, maxDiffPixelRatio, threshold } = options;
      const compare = { maxDiffPixels, maxDiffPixelRatio, threshold };
      (pwExpect(png) as any).toMatchSnapshot(snapshotName, JSON.parse(JSON.stringify(compare)));
    });
    let screenshotCounter = 0;
    try {
      await use(app);
    } finally {
      setStepRunner(undefined);
      setScreenshotComparator(undefined);
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (app.tracing.isRecording) {
        const keep = traceMode === 'on' || traceMode === 'on-first-retry' || traceMode === 'on-all-retries' || failed;
        const html = traceFormat === 'html';
        const path = testInfo.outputPath(html ? 'trace.html' : 'qt-trace.zip');
        const written = await app.tracing.stop(keep ? { path } : {}).catch(() => undefined);
        // the HTML report links a "trace" zip attachment to Playwright's trace viewer
        if (written && keep) await testInfo.attach('trace', { path, contentType: html ? 'text/html' : 'application/zip' });
      }
      if (app.isRunning() && (qtScreenshot === 'on' || (qtScreenshot === 'only-on-failure' && failed))) {
        for (const { window, png } of await app.screenshotAllWindows().catch(() => [])) {
          const name = window.objectName || window.id || window.text || `window-${window.handle}`;
          await testInfo.attach(`screenshot-${name}.png`, { body: png, contentType: 'image/png' });
        }
      }
      if (failed && app.output()) await testInfo.attach('app-output.txt', { body: app.output(), contentType: 'text/plain' });
      await app.close();
      const recorded = app.video();
      if (recorded && recordVideo) {
        if (videoMode === 'retain-on-failure' && !failed) await recorded.delete();
        else await testInfo.attach('video', { path: await recorded.path(), contentType: 'video/mp4' });
      }
    }
  },
});

export interface QtExpect extends Expect<{}> {
  (subject: Locator): LocatorAssertions;
  (subject: SignalSpy): SignalSpyAssertions;
  (subject: QtApp): AppAssertions;
}

/** Playwright's expect, extended with qt-playwright's assertions for Locators and SignalSpies. */
export const expect: QtExpect = Object.assign(
  (actual: unknown, ...rest: unknown[]) =>
    isQtSubject(actual) ? qtExpect(actual as any) : (pwExpect as any)(actual, ...rest),
  pwExpect,
) as unknown as QtExpect;

export * from './index';
