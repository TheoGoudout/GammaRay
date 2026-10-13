// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

// Records a slowed-down walkthrough of the sample app, without the test runner:
//   node scripts/record-demo.mjs [output-dir]
// Produces demo.mp4, demo.gif and a few PNG screenshots. Uses QTPW_SAMPLEAPP and
// QT_PLAYWRIGHT_GAMMARAY like the test suite.

import {mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,
        join,
        resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {expect, launch} = require('qt-playwright');

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, '..', 'demo-output'));
mkdirSync(out, {recursive : true});
const sampleApp = process.env.QTPW_SAMPLEAPP ?? join(here, '..', 'sampleapp', 'build', 'sampleapp');

const app = await launch(sampleApp, [], {slowMo : 250, headless : true});
try {
    const mp4 = await app.startVideo(join(out, 'demo.mp4'), {fps : 25});
    const gif = await app.startVideo(join(out, 'demo.gif'), {fps : 8, scale : 0.5});

    const w = app.locator('#widgetsWindow');
    await w.locator('#username').pressSequentially('admin');
    await w.locator('#password').fill('secret');
    await w.locator('#rememberMe').check();
    await w.locator('#loginButton').click();
    await expect(w.locator('#statusLabel')).toHaveText('Welcome, admin!');
    await w.locator('#hoverLabel').hover();
    await w.locator('#volumeSlider').dragBy(200, 0, {sourcePosition : {x : 5, y : 8}, steps : 25});
    await w.locator('#longList').scroll({deltaY : 360});

    await w.locator('#itemList').setProperty('currentRow', 1);
    await w.locator('#removeButton').click();
    await expect(w.locator('#confirmDialog')).toBeVisible();
    await app.screenshot({path : join(out, 'widgets-dialog.png')});
    await w.locator('#confirmDialog').getByText('OK').click();

    const q = app.locator('#qmlWindow');
    await q.locator('#usernameField').pressSequentially('admin');
    await q.locator('#passwordField').fill('secret');
    await q.locator('#loginButton').click();
    await q.locator('#newTodoField').fill('Record a video');
    await q.locator('#addButton').click();
    await q.locator('#todoList').getByText('Record a video').dblclick();
    await q.locator('#draggable').dragBy(200, 0, {steps : 25});
    await q.locator('#volumeSlider').dragTo(q.locator('#volumeLabel'), {sourcePosition : {x : 8, y : 20}});
    await q.locator('#hoverArea').hover();
    await q.locator('#clearButton').click();
    await expect(q.locator('#confirmText')).toBeVisible();
    await q.screenshot({path : join(out, 'qml-dialog.png')});
    await q.locator('Dialog#confirmDialog').getByText('OK').click();
    await q.locator('#longList').scroll({deltaY : 720});
    await new Promise((r) => setTimeout(r, 600));

    await w.screenshot({path : join(out, 'widgets-window.png')});
    await q.screenshot({path : join(out, 'qml-window.png')});
    await Promise.all([ mp4.stop(), gif.stop() ]);
    console.log(`written to ${out}`);
} finally {
    await app.close();
}
