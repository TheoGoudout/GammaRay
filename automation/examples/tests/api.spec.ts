// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { expect, QtError, StrictModeViolationError, test, TimeoutError } from 'qt-playwright/test';

// Locator engine, auto-waiting, strict mode and error reporting.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe('locators', () => {
  test('selector syntax', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    // type (C++ class and base classes)
    await expect(w.locator('QLineEdit')).toHaveCount(4);
    await expect(w.locator('QAbstractButton')).toHaveCount(6); // 5 push buttons + check box
    // type + id + property filters; quoted and bare values; != and *=
    await expect(w.locator('QLineEdit#password[echoMode=Password]')).toHaveCount(1);
    await expect(w.locator('QLineEdit[echoMode!=Password]')).toHaveCount(3);
    await expect(w.locator('QLineEdit[readOnly]')).toHaveProperty('objectName', 'serialField');
    await expect(w.locator('QPushButton[text*="Rem"]')).toHaveText('Remove');
    await expect(w.locator('QPushButton[text=/^(Add|Remove)$/]')).toHaveCount(2);
    await expect(w.locator('[placeholderText="User name"]')).toHaveProperty('objectName', 'username');
    // descendant chaining
    await expect(w.locator('#loginBox >> QLineEdit')).toHaveCount(2);
    await expect(w.locator('#listBox >> QLineEdit')).toHaveCount(1);
    // nth / first / last, as selector segments and as methods
    await expect(w.locator('QPushButton >> nth=1')).toHaveText('Add');
    await expect(w.locator('#listBox >> QPushButton >> last')).toHaveText('Remove');
    await expect(w.locator('#listBox >> QPushButton').nth(-2)).toHaveText('Add');
    await expect(w.locator('QPushButton').last()).toHaveText('Reset...');
    await expect(w.locator('QPushButton').first()).toHaveProperty('objectName', 'loginButton');
    // visibility filter: the QML dialog's buttons exist but are not shown
    const qml = app.locator('#qmlWindow');
    const buttons = await qml.locator('Button').count();
    await expect(qml.locator('Button').visible()).toHaveCount(buttons - 2);
    await expect(qml.locator('Button >> visible=false')).toHaveCount(2);
  });

  test('locators are lazy and re-resolve', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    const dialogText = w.locator('#confirmDialog >> #confirmText');
    await expect(dialogText).toHaveCount(0);
    for (const row of [0, 1]) {
      // a new QDialog is created for every exec(); the same locator finds each one
      await w.locator('#itemList').setProperty('currentRow', row);
      await w.locator('#removeButton').click();
      await expect(dialogText).toHaveText(row === 0 ? "Remove 'Apple'?" : "Remove 'Banana'?");
      await app.press('Escape');
      await expect(dialogText).toHaveCount(0);
    }
  });

  test('all() and count()', async ({ app }) => {
    const items = app.locator('#qmlWindow >> #todoList >> ItemDelegate');
    const texts = [];
    for (const item of await items.all()) texts.push(await item.textContent());
    expect(texts).toEqual(['Write tests', 'Fix bugs', 'Ship it']);
    expect(await items.count()).toBe(3);
  });

  test('windows() and describe()', async ({ app }) => {
    const windows = await app.windows();
    expect(windows.map((w) => w.objectName).sort()).toEqual(['qmlWindow', 'widgetsWindow']);
    const info = await app.locator('#widgetsWindow >> #loginButton').describe();
    expect(info).toMatchObject({ type: 'QPushButton', className: 'QPushButton', objectName: 'loginButton', text: '&Login', visible: true, enabled: false });
    expect(info.typeNames).toEqual(expect.arrayContaining(['QPushButton', 'QAbstractButton', 'QWidget', 'QObject']));
    expect(info.geometry!.width).toBeGreaterThan(0);
    const props = await app.locator('#widgetsWindow').getProperties();
    expect(props).toMatchObject({ objectName: 'widgetsWindow', windowTitle: 'Widgets Demo', loginAttempts: 0 });
  });
});

test.describe('auto-waiting', () => {
  test('actions wait for the element to become enabled', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    await w.locator('#username').fill('admin');
    const started = Date.now();
    // the login button only becomes enabled once the password is typed, 300 ms later
    await Promise.all([
      w.locator('#loginButton').click(),
      (async () => {
        await sleep(300);
        await w.locator('#password').fill('secret');
      })(),
    ]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    await expect(w.locator('#statusLabel')).toHaveText('Welcome, admin!');
  });

  test('actions wait for the element to appear', async ({ app }) => {
    const qml = app.locator('#qmlWindow');
    const newTodo = qml.locator('#todoList').getByText('Appears later');
    await Promise.all([
      newTodo.click(),
      (async () => {
        await sleep(300);
        await qml.invoke('addTodo', 'Appears later');
      })(),
    ]);
    await expect(qml.locator('#todoList')).toHaveProperty('currentIndex', 3);
  });

  test('waitFor states', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    const dialog = w.locator('#confirmDialog');
    await dialog.waitFor({ state: 'detached' });
    await w.locator('#itemList').setProperty('currentRow', 0);
    await w.locator('#removeButton').click();
    await dialog.waitFor(); // visible
    await dialog.waitFor({ state: 'attached' });
    await app.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    expect(await dialog.isVisible()).toBe(false);
    expect(await w.locator('#loginButton').isVisible()).toBe(true);
    expect(await w.locator('#loginButton').isEnabled()).toBe(false);
  });
});

test.describe('errors', () => {
  test('strict mode rejects ambiguous locators for actions', async ({ app }) => {
    // both windows contain a #loginButton
    const error = await app.locator('#loginButton').click().catch((e) => e);
    expect(error).toBeInstanceOf(StrictModeViolationError);
    expect(error.message).toContain('resolved to 2 elements');
    expect(error.message).toContain('QPushButton objectName=loginButton');
    expect(error.message).toContain('Button id=loginButton');
  });

  test('timeouts explain what was being waited for', async ({ app }) => {
    const error = await app.locator('#widgetsWindow >> #loginButton').click({ timeout: 300 }).catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toContain('Timeout 300ms exceeded');
    expect(error.message).toContain('element is not enabled');

    const missing = await app.locator('#doesNotExist').click({ timeout: 200 }).catch((e) => e);
    expect(missing.message).toContain('waiting for locator("#doesNotExist")');
  });

  test('assertion failures show expected and received values', async ({ app }) => {
    const error = await expect(app.locator('#widgetsWindow >> #statusLabel'))
      .toHaveText('Something else', { timeout: 200 })
      .catch((e) => e);
    expect(error.message).toContain("Expected: 'Something else'");
    expect(error.message).toContain("Received: 'Please log in'");
  });

  test('invalid selectors and unknown members are reported by the app', async ({ app }) => {
    const bad = await app.locator('QPushButton[text=').count().catch((e) => e);
    expect(bad).toBeInstanceOf(QtError);
    expect(bad.message).toContain('invalid selector');

    const w = app.locator('#widgetsWindow');
    await expect(w.getProperty('noSuchProperty')).rejects.toThrow(/has no property 'noSuchProperty'/);
    await expect(w.invoke('noSuchMethod')).rejects.toThrow(/has no method 'noSuchMethod'/);
    await expect(w.invoke('addItems')).rejects.toThrow(/takes 0 argument/);
    await expect(w.waitForSignal('loggedIn', { timeout: 200 })).rejects.toThrow(/timed out after 200 ms/);
  });
});
