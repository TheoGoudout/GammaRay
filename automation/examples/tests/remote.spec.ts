// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { existsSync } from 'node:fs';
import path from 'node:path';
import { connect, expect, launch, runServer, test, type RunningServer } from 'qt-playwright/test';

// Remote applications: `qt-playwright server` on the machine with the application, tests
// elsewhere. Here both run on this machine; the server is started in-process.

const sampleApp = process.env.QTPW_SAMPLEAPP ?? path.resolve(__dirname, '../sampleapp/build/sampleapp');

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.describe('remote launch', () => {
  let server: RunningServer;
  test.beforeAll(async () => {
    server = await runServer({ port: 0, token: 'secret', gammaray: process.env.QT_PLAYWRIGHT_GAMMARAY, log: () => {} });
  });
  test.afterAll(async () => {
    await server.close();
  });

  test('launches through the server and relays the automation connection', async ({}, testInfo) => {
    const app = await launch(sampleApp, ['--widgets-only'], { remote: { url: server.url, token: 'secret' }, headless: true });
    try {
      const w = app.locator('#widgetsWindow');
      await w.getByLabel('User:').fill('admin');
      await w.getByLabel('Password:').fill('secret');
      await w.getByRole('button', { name: 'Login' }).click();
      await expect(w.locator('#statusLabel')).toHaveText('Welcome, admin!');
      // the application's output is forwarded
      expect(app.output()).toContain('GammaRay automation server listening');
      // binary messages (video frames) are relayed too
      const video = await app.startVideo(testInfo.outputPath('remote.mp4'), { fps: 10 });
      await w.locator('#volumeSlider').setProperty('value', 50);
      expect(existsSync(await video.stop())).toBe(true);
      expect((await w.screenshot()).subarray(1, 4).toString()).toBe('PNG');
    } finally {
      await app.close();
    }
    // closing the connection terminates the remote application
    await expect.poll(() => processExists(app.pid)).toBe(false);
  });

  test('requires the token', async () => {
    await expect(launch(sampleApp, [], { remote: { url: server.url, token: 'wrong' } })).rejects.toThrow(/rejected the token/);
    await expect(launch(sampleApp, [], { remote: server.url.replace('ws://', '') })).rejects.toThrow(/rejected the token/);
  });

  test('only launches allowed executables', async () => {
    const restricted = await runServer({ port: 0, token: '', apps: ['/usr/bin/true'], log: () => {} });
    try {
      await expect(launch(sampleApp, [], { remote: restricted.url })).rejects.toThrow(/does not launch/);
    } finally {
      await restricted.close();
    }
  });
});

test('connect() attaches to a running application without owning it', async ({ app }) => {
  // e.g. a device without Node.js; here: a second connection to the fixture's app
  const shared = await connect(app.connection.url);
  await shared.locator('#widgetsWindow >> #username').fill('shared');
  await expect(app.locator('#widgetsWindow >> #username')).toHaveValue('shared');
  await shared.close();
  expect(app.isRunning()).toBe(true);
  await expect(app.locator('#widgetsWindow >> #username')).toHaveValue('shared');
});
