// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { expect, test } from 'qt-playwright/test';

// QtWidgets login form: fill, click, press, check, auto-waiting on enabled state,
// properties, invokable methods and signals.
//
// The sample app shows a Widgets and a QML window with the same object names, so
// locators are scoped to the window (strict mode would reject ambiguous ones).

test.describe('widgets login form', () => {
  test('logs in with valid credentials', async ({ app }) => {
    const window = app.locator('#widgetsWindow');
    const loginButton = window.locator('#loginButton');

    await expect(loginButton).toBeDisabled();
    await window.locator('#username').fill('admin');
    await window.locator('#password').fill('secret');
    await expect(loginButton).toBeEnabled();

    const loggedIn = await window.spy('loggedIn');
    await loginButton.click();

    await expect(window.locator('#statusLabel')).toHaveText('Welcome, admin!');
    await expect(loggedIn).toHaveBeenEmittedWith(['admin']);
    expect(await loggedIn.wait()).toEqual(['admin']);
    await expect(window).toHaveProperty('loginAttempts', 1);
  });

  test('rejects invalid credentials', async ({ app }) => {
    await app.locator('#widgetsWindow >> #username').fill('admin');
    await app.locator('#widgetsWindow >> #password').fill('wrong');
    // Enter in the password field triggers login via returnPressed
    await app.locator('#widgetsWindow >> #password').press('Enter');
    await expect(app.locator('#widgetsWindow >> #statusLabel')).toHaveText('Invalid credentials');
    await expect(app.locator('#widgetsWindow >> #statusLabel')).not.toHaveText(/Welcome/);
  });

  test('fill replaces existing text, pressSequentially appends', async ({ app }) => {
    const user = app.locator('#widgetsWindow >> #username');
    await user.fill('first');
    await user.fill('second');
    await expect(user).toHaveValue('second');
    await user.pressSequentially(' + more');
    await expect(user).toHaveValue('second + more');
    await user.press('Control+A');
    await user.press('Backspace');
    await expect(user).toHaveValue('');
    await user.type('MiXeD Case 123!');
    await expect(user).toHaveText('MiXeD Case 123!');
    await user.clear();
    await expect(user).toHaveText('');
  });

  test('checkbox check/uncheck', async ({ app }) => {
    const remember = app.locator('#widgetsWindow >> #rememberMe');
    await expect(remember).not.toBeChecked();
    await remember.check();
    await expect(remember).toBeChecked();
    expect(await remember.isChecked()).toBe(true);
    await remember.uncheck();
    await expect(remember).toBeChecked({ checked: false });
    // clicking toggles too
    await remember.click();
    await expect(remember).toHaveProperty('checked', true);
  });

  test('waitForSignal resolves with the signal arguments', async ({ app }) => {
    const window = app.locator('#widgetsWindow');
    await app.locator('#widgetsWindow >> #username').fill('admin');
    await app.locator('#widgetsWindow >> #password').fill('secret');
    // the wait is registered in the app before the click is delivered
    const [args] = await Promise.all([window.waitForSignal('loggedIn(QString)'), app.locator('#widgetsWindow >> #loginButton').click()]);
    expect(args).toEqual(['admin']);
  });

  test('invoke methods and read/write properties', async ({ app }) => {
    const window = app.locator('#widgetsWindow');
    await app.locator('#widgetsWindow >> #username').fill('someone');
    await app.locator('#widgetsWindow >> #rememberMe').check();

    await window.invoke('resetForm');
    await expect(app.locator('#widgetsWindow >> #username')).toHaveText('');
    await expect(app.locator('#widgetsWindow >> #rememberMe')).not.toBeChecked();

    await app.locator('#widgetsWindow >> #username').setProperty('text', 'set directly');
    expect(await app.locator('#widgetsWindow >> #username').getProperty('text')).toBe('set directly');
    // enum properties read and write as key names
    expect(await app.locator('#widgetsWindow >> #password').getProperty('echoMode')).toBe('Password');
    await app.locator('#widgetsWindow >> #password').setProperty('echoMode', 'Normal');
    await expect(app.locator('#widgetsWindow >> #password')).toHaveProperty('echoMode', 'Normal');
  });

  test('text selectors strip mnemonics and match exactly or by substring', async ({ app }) => {
    // the button's text is "&Login"
    await expect(app.locator('#widgetsWindow >> QPushButton >> text="Login"')).toHaveCount(0); // not a descendant of itself
    await expect(app.locator('#widgetsWindow >> text="Login"')).toHaveCount(2); // group box title + button
    await expect(app.locator('#widgetsWindow >> QPushButton[text="&Login"]')).toHaveCount(1);
    await expect(app.locator('#widgetsWindow >> text=please LOG')).toHaveText('Please log in');
    await expect(app.locator('#widgetsWindow >> text=/^Please/')).toHaveCount(1);
    await expect(app.locator('#widgetsWindow').getByText('Login').last()).toHaveProperty('objectName', 'loginButton');
  });
});
