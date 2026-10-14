// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { inflateRawSync } from 'node:zlib';
import { expect, test } from 'qt-playwright/test';

// Traces in Playwright's own format: `npx playwright show-trace trace.zip` opens them.

/** Reads the entries of a zip archive (stored or deflated, as written by qt-playwright). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); ++i) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    const local = buf.readUInt32LE(p + 42);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + size);
    entries.set(name, method === 8 ? inflateRawSync(data) : data);
    p += 46 + nameLength + extra;
  }
  return entries;
}

test('tracing writes Playwright trace.zip files', async ({ app }, testInfo) => {
  await app.tracing.start({ title: 'login' });
  const w = app.locator('#widgetsWindow');
  await w.getByLabel('User:').fill('admin');
  await w.getByLabel('Password:').fill('secret');
  await w.getByRole('button', { name: 'Login' }).click();
  await expect(w.locator('#statusLabel')).toHaveText('Welcome, admin!');
  await w.locator('#nope').click({ timeout: 300 }).catch(() => undefined);
  const path = testInfo.outputPath('trace.zip');
  const zip = await app.tracing.stop({ path });
  await testInfo.attach('trace', { path, contentType: 'application/zip' });

  const files = unzip(zip);
  const events = files.get('trace.trace')!.toString().trim().split('\n').map((l) => JSON.parse(l));
  const ofType = (type: string) => events.filter((e) => e.type === type);

  expect(ofType('context-options')[0]).toMatchObject({ version: 10, title: 'login' });
  // one action per API call, with Playwright's titles
  const titles = ofType('before').map((e) => e.title);
  expect(titles).toContain("locator('#widgetsWindow').getByRole('button', { name: 'Login' }).click");
  expect(titles.some((t) => t.startsWith('expect('))).toBe(true);
  const failed = ofType('after').find((e) => e.error);
  expect(failed.error.message).toContain('Timeout 300ms exceeded');
  // the call log of the failed action says what it was waiting for
  expect(ofType('log').some((l) => l.callId === failed.callId && /waiting for/.test(l.message))).toBe(true);

  // the click has an input point and before/action/after snapshots marking the target
  const click = ofType('before').find((e) => e.title.endsWith(".getByRole('button', { name: 'Login' }).click"));
  // the call site, for the viewer's Source tab (and UI mode)
  expect(click.stack[0]).toMatchObject({ file: expect.stringMatching(/trace\.spec\.ts$/), line: 34 });
  expect(ofType('input').find((e) => e.callId === click.callId).point).toEqual({ x: expect.any(Number), y: expect.any(Number) });
  const snapshots = ofType('frame-snapshot').filter((e) => e.snapshot.callId === click.callId);
  expect(snapshots.map((s) => s.snapshot.phase)).toEqual(['before', 'action', 'after']);
  const actionHtml = JSON.stringify(snapshots[1].snapshot.html);
  expect(actionHtml).toContain('"__playwright_target__":"' + click.callId + '"');
  expect(actionHtml).toContain('"role":"button","aria-label":"Login"');
  expect(actionHtml).toContain('"data-testid":"loginButton"');

  // screenshots: a film strip and the snapshots' background images, stored once
  const frames = ofType('screencast-frame');
  expect(frames.length).toBeGreaterThan(2);
  for (const f of frames) expect(files.has(f.file)).toBe(true);
  const network = files.get('trace.network')!.toString().trim().split('\n').map((l) => JSON.parse(l));
  expect(network.length).toBe(frames.length);
  expect(files.get(frames[0].file)!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
});
