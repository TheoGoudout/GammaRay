// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { expect, test } from 'qt-playwright/test';

// The inspector (app.pause(), QTPW_DEBUG=1, `qt-playwright inspect`) is a local web page; these
// tests drive its HTTP API the way the page does.

async function api<T = any>(base: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return (await r.json()) as T;
}

test('highlight() draws into the application windows', async ({ app }) => {
  const w = app.locator('#widgetsWindow');
  const before = await w.screenshot({ caret: 'hide' });
  await w.getByRole('button', { name: 'Login' }).highlight();
  expect((await w.screenshot({ caret: 'hide' })).equals(before)).toBe(false);
  await app.hideHighlight();
  await expect.poll(async () => (await w.screenshot({ caret: 'hide' })).equals(before)).toBe(true);

  // the overlay does not take input or show up as an element
  await w.getByLabel('User:').highlight();
  await expect(w.locator('[objectName="qt_playwright_highlight"]')).toHaveCount(0);
  await w.getByLabel('User:').fill('admin');
  await expect(w.getByLabel('User:')).toHaveValue('admin');
});

test('inspector: live view, locator playground and pick locator', async ({ app }) => {
  const inspector = await app.inspector({ open: false });
  const base = inspector.url;
  expect(await (await fetch(base)).text()).toContain('qt-playwright Inspector');
  // every request needs the token
  expect((await fetch(new URL('/api/state', base))).status).toBe(404);

  const state = await api(base, 'api/state');
  expect(state).toMatchObject({ appName: 'qtpw-sampleapp', running: true, paused: null });
  const shot = await api(base, 'api/screenshot');
  expect(shot.canvas.width).toBeGreaterThan(0);
  expect(Buffer.from(shot.image, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

  // locator playground: the same expressions as in tests, matches highlighted in the app
  const found = await api(base, 'api/locate', { expression: "getByRole('button', { name: 'Login' })" });
  expect(found.count).toBe(2); // one per window
  expect(found.boxes).toHaveLength(2);
  expect((await api(base, 'api/locate', { expression: 'getByRole(' })).error).toBeTruthy();

  // pick locator: the element under the pointer (from the snapshot tree) gets a unique locator
  const tree = await api(base, 'api/tree');
  const find = (nodes: any[]): any => nodes.map((n) => (n.objectName === 'username' ? n : find(n.children ?? []))).find(Boolean);
  const username = find(tree.windows);
  expect(username.role).toBe('textbox');
  const picked = await api(base, 'api/pick', { handle: username.handle });
  expect(picked.code).toBe("app.getByRole('textbox', { name: 'User:' })");
  expect(picked.info.objectName).toBe('username');
  await expect(app.getByRole('textbox', { name: 'User:' })).toHaveCount(1);
});

test('inspector: pause, step over and resume', async ({ app }) => {
  const inspector = await app.inspector({ open: false });
  const base = inspector.url;
  const w = app.locator('#widgetsWindow');

  const paused = inspector.pause('test');
  await expect.poll(async () => (await api(base, 'api/state')).paused?.title).toBe('test');
  await api(base, 'api/step', {}); // resume, then pause before the next action

  const fill = w.getByLabel('User:').fill('stepped');
  await paused;
  // paused before fill(), with its target known (highlighted in the app)
  await expect.poll(async () => (await api(base, 'api/state')).paused?.title).toBe("locator('#widgetsWindow').getByLabel('User:').fill");
  expect(await w.getByLabel('User:').inputValue()).toBe('');
  await api(base, 'api/resume', {});
  await fill;
  await expect(w.getByLabel('User:')).toHaveValue('stepped');
  const actions = (await api(base, 'api/state')).actions;
  expect(actions.find((a: any) => a.title.endsWith('.fill'))).toMatchObject({ status: 'passed' });
});

test('inspector: recording', async ({ app }) => {
  const inspector = await app.inspector({ open: false });
  const base = inspector.url;
  expect((await api(base, 'api/record', { on: true })).recording).toBe(true);
  await app.locator('#widgetsWindow >> #rememberMe').click();
  await expect.poll(async () => (await api(base, 'api/state')).code).toEqual(["await app.getByTestId('rememberMe').check();"]);
  expect((await api(base, 'api/record', { on: false })).recording).toBe(false);
});
