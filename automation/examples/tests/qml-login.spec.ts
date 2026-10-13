// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { expect, test } from 'qt-playwright/test';

// Qt Quick Controls login form: QML ids and QML type names as selectors, bindings,
// QML signals and JavaScript functions.

test.describe('QML login form', () => {
  test('logs in with valid credentials', async ({ app }) => {
    const win = app.locator('#qmlWindow');
    const login = win.locator('Button#loginButton');

    await expect(login).toBeDisabled(); // enabled is bound to both fields being non-empty
    await win.locator('#usernameField').fill('admin');
    await win.locator('#passwordField').fill('secret');
    await expect(login).toBeEnabled();

    const loggedIn = await win.spy('loggedIn');
    await login.click();
    await expect(win.locator('#statusLabel')).toHaveText('Welcome, admin!');
    await expect(loggedIn).toHaveBeenEmittedTimes(1);
    expect(await loggedIn.wait()).toEqual(['admin']);
    await expect(win).toHaveProperty('loginAttempts', 1);
  });

  test('Enter in the password field submits', async ({ app }) => {
    const win = app.locator('#qmlWindow');
    await win.locator('#usernameField').fill('admin');
    await win.locator('#passwordField').fill('nope');
    await win.locator('#passwordField').press('Enter');
    await expect(win.locator('#statusLabel')).toHaveText('Invalid credentials');
    await expect(win.locator('#passwordField')).toBeFocused();
  });

  test('QML type selectors', async ({ app }) => {
    const win = app.locator('#qmlWindow');
    await expect(win.locator('TextField')).toHaveCount(3);
    await expect(win.locator('TextField[echoMode=Password]')).toHaveCount(1);
    await expect(win.locator('TextField').first()).toHaveProperty('placeholderText', 'User name');
    await expect(win.locator('TextField').last()).toHaveProperty('placeholderText', 'New todo');
    expect((await win.locator('TextField').nth(1).describe()).id).toBe('passwordField');
    // base types match too: a Button is an AbstractButton and an Item
    await expect(win.locator('AbstractButton#loginButton')).toHaveCount(1);
    await expect(win.locator('Item#loginButton')).toHaveCount(1);
    // the generated class name of QML-defined types also works
    await expect(win.locator('Main')).toHaveCount(0); // the window itself is not its own descendant
    await expect(app.locator('Main')).toHaveCount(1);
  });

  test('checkbox and text selectors', async ({ app }) => {
    const win = app.locator('#qmlWindow');
    const remember = win.getByText('Remember me');
    expect((await remember.describe()).id).toBe('rememberCheck');
    await remember.check();
    await expect(win.locator('#rememberCheck')).toBeChecked();
    await expect(win.locator('CheckBox[checked=true]')).toHaveCount(1);
    await remember.uncheck();
    await expect(win.locator('CheckBox[checked]')).toHaveCount(0);
  });

  test('waitForSignal and JavaScript functions', async ({ app }) => {
    const win = app.locator('#qmlWindow');
    await win.locator('#usernameField').fill('admin');
    await win.locator('#passwordField').fill('secret');
    const [args] = await Promise.all([win.waitForSignal('loggedIn'), win.locator('#loginButton').click()]);
    expect(args).toEqual(['admin']);

    // call a QML function, read back properties
    expect(await win.invoke('reset')).toBe(true);
    await expect(win.locator('#usernameField')).toHaveText('');
    await expect(win.locator('#statusLabel')).toHaveText('Please log in');
    await win.locator('#statusLabel').setProperty('text', 'Set from the test');
    await expect(win.locator('#statusLabel')).toContainText('from the test');
  });
});
