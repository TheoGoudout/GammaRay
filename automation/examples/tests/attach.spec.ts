// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { spawn, spawnSync } from 'node:child_process';
import { attach, expect, launch, test } from 'qt-playwright/test';

// Connecting to applications that were not started by the test fixture.

const sampleApp = () => test.info().project.use.qtApp!.executable;

test.describe('attach', () => {
  test('a second client can attach by URL', async ({ app }) => {
    const second = await attach(app.connection.url);
    try {
      expect(second.pid).toBe(app.pid);
      await second.locator('#widgetsWindow >> #username').fill('from second client');
      await expect(app.locator('#widgetsWindow >> #username')).toHaveText('from second client');
    } finally {
      await second.close(); // detaching leaves the application running
    }
    expect(app.isRunning()).toBe(true);
    await expect(app.locator('#widgetsWindow >> #username')).toBeVisible();
  });

  test('launch() and close() without the fixture', async () => {
    const app = await launch(sampleApp(), ['--qml-only']);
    try {
      expect(app.info.appName).toBe('qtpw-sampleapp');
      expect(app.info.platform).toBe('offscreen');
      expect((await app.windows()).map((w) => w.objectName)).toEqual(['qmlWindow']);
      // with only one window, unscoped locators are unambiguous
      await app.locator('#usernameField').fill('solo');
      await expect(app.getById('usernameField')).toHaveText('solo');
    } finally {
      await app.close();
    }
    expect(app.isRunning()).toBe(false);
  });

  test('inject into a running process by pid', async () => {
    test.skip(spawnSync('gdb', ['--version']).status !== 0, 'needs gdb (the default attach injector on Linux)');
    const env = { ...process.env, QT_QPA_PLATFORM: 'offscreen', QT_QUICK_BACKEND: 'software' };
    const target = spawn(sampleApp(), ['--widgets-only'], { env, stdio: 'ignore' });
    try {
      // give the app a moment to start; attaching to a process still loading Qt fails
      await new Promise((r) => setTimeout(r, 1500));
      const app = await attach(target.pid!);
      try {
        expect(app.pid).toBe(target.pid);
        await app.locator('#username').fill('attached');
        await expect(app.locator('#username')).toHaveText('attached');
      } finally {
        await app.close();
      }
      expect(target.exitCode).toBeNull(); // still running after detaching
    } finally {
      target.kill();
    }
  });
});
