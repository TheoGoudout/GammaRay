// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, launch, test } from 'qt-playwright/test';

// Session recording: all windows composed into one video, encoded with ffmpeg.

interface Probe {
  codec: string;
  width: number;
  height: number;
  duration: number;
  frames: number;
}

function ffprobe(path: string): Probe {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration',
    '-of', 'json', path,
  ]).toString();
  const json = JSON.parse(out);
  const s = json.streams[0];
  return {
    codec: s.codec_name,
    width: s.width,
    height: s.height,
    duration: Number(json.format.duration),
    frames: Number(s.nb_read_frames),
  };
}

async function loginFlow(app: import('qt-playwright').QtApp) {
  const w = app.locator('#widgetsWindow');
  await w.locator('#username').fill('admin');
  await w.locator('#password').fill('secret');
  await w.locator('#loginButton').click();
  await expect(w.locator('#statusLabel')).toHaveText('Welcome, admin!');
  const q = app.locator('#qmlWindow');
  await q.locator('#draggable').dragBy(150, 0, { steps: 20 });
  await q.locator('#clearButton').click();
  await expect(q.locator('#confirmText')).toBeVisible();
  await app.press('Escape');
  await expect(q.locator('#confirmText')).toBeHidden();
}

test.describe('video recording', () => {
  test('startVideo() records all windows into an mp4', async ({ app }, testInfo) => {
    const path = testInfo.outputPath('session.mp4');
    const video = await app.startVideo(path, { fps: 25 });
    const started = Date.now();
    await loginFlow(app);
    await new Promise((r) => setTimeout(r, 300));
    // before stop(): finishing the encoding takes a while, especially under load
    const elapsed = (Date.now() - started) / 1000;
    expect(await video.stop()).toBe(path);

    const info = ffprobe(path);
    expect(info.codec).toBe('h264');
    // both windows side by side (920 px wide incl. the gap) plus a title bar
    expect(info.width).toBeGreaterThanOrEqual(920);
    expect(info.height).toBeGreaterThanOrEqual(760);
    expect(info.width % 2).toBe(0);
    // plays back in real time: constant 25 fps for the whole session (which started before
    // startVideo() returned and ended after stop() was called)
    expect(info.duration).toBeGreaterThan(elapsed - 0.1);
    expect(info.duration).toBeLessThan(elapsed + 1);
    expect(info.frames).toBeGreaterThanOrEqual(Math.floor(info.duration * 25) - 1);
    await testInfo.attach('session', { path, contentType: 'video/mp4' });
  });

  test('size, scale and other formats', async ({ app }, testInfo) => {
    const webm = await app.startVideo(testInfo.outputPath('small.webm'), { size: { width: 640, height: 360 }, fps: 10 });
    const gif = await app.startVideo(testInfo.outputPath('half.gif'), { scale: 0.5, fps: 5, chrome: false, cursor: false });
    await app.locator('#widgetsWindow >> #hoverLabel').hover();
    await app.locator('#widgetsWindow >> #volumeSlider').setProperty('value', 70);
    await new Promise((r) => setTimeout(r, 500));
    await Promise.all([webm.stop(), gif.stop()]);

    const small = ffprobe(testInfo.outputPath('small.webm'));
    expect(small).toMatchObject({ codec: 'vp8', width: 640, height: 360 });
    const half = ffprobe(testInfo.outputPath('half.gif'));
    expect(half.codec).toBe('gif');
    expect(half.width).toBe(470); // (460 + 20 + 460) / 2, no title bars
    expect(half.height).toBe(430); // the taller widgets window: 860 / 2
  });

  test('recordVideo launch option, like Playwright', async ({}, testInfo) => {
    const dir = testInfo.outputPath('videos');
    const app = await launch(test.info().project.use.qtApp!.executable, ['--qml-only'], { recordVideo: { dir } });
    const video = app.video()!;
    expect(video).not.toBeNull();
    const path = await video.path();
    expect(path.startsWith(dir)).toBe(true);
    expect(path.endsWith('.mp4')).toBe(true);

    await app.locator('#usernameField').fill('recorded');
    await app.locator('#rememberCheck').check();
    await app.close(); // finalizes the file

    expect(statSync(path).size).toBeGreaterThan(1000);
    expect(ffprobe(path).width).toBe(460);
    const copy = join(dir, 'copy.mp4');
    await video.saveAs(copy);
    expect(existsSync(copy)).toBe(true);
    await video.delete();
    expect(existsSync(path)).toBe(false);
  });
});

test.describe('video fixture option', () => {
  // records every test in this group and attaches the mp4 to the HTML report
  test.use({ qtVideo: 'on' });

  test('login flow is recorded by the fixture', async ({ app }) => {
    expect(app.video()).not.toBeNull();
    await loginFlow(app);
  });
});
