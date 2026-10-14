// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { expect, launch, test, type QtApp } from 'qt-playwright/test';

// Codegen: interactions are recorded as test code. Input injected by the API goes through
// the same path as real user input, so the recorder can be tested by driving the app.

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/** Runs recorded lines against @p app (what a generated test file would do). */
async function replay(app: QtApp, lines: string[]): Promise<void> {
  await new AsyncFunction('app', lines.join('\n'))(app);
}

test.describe('codegen', () => {
  test('records widget interactions with readable, unique locators', async ({ app }) => {
    const recorder = await app.startCodegen();
    const w = app.locator('#widgetsWindow');
    await w.locator('#username').fill('admin');
    await w.locator('#password').pressSequentially('secret');
    await w.locator('#rememberMe').click();
    await w.locator('#loginButton').click();
    await w.locator('#colorCombo').selectOption('Green');
    await w.locator('#password').press('Enter');
    const code = await recorder.stop({ testName: 'login' });

    // locators in Playwright's order of preference: role + accessible name (the form label),
    // then test id (objectName) when role + name is ambiguous (both windows have a "Login" button)
    expect(recorder.lines()).toEqual([
      "await app.getByRole('textbox', { name: 'User:' }).fill('admin');",
      "await app.getByRole('textbox', { name: 'Password:' }).fill('secret');",
      "await app.getByTestId('rememberMe').check();",
      "await app.getByTestId('loginButton').click();",
      "await app.getByRole('combobox', { name: 'Color:' }).selectOption('Green');",
      "await app.getByRole('textbox', { name: 'Password:' }).press('Enter');",
    ]);
    expect(code).toContain("test('login', async ({ app }) => {");
    await expect(w.locator('#statusLabel')).toHaveText('Welcome, admin!');
  });

  test('records Qt Quick interactions, including combo boxes and drags', async ({ app }) => {
    const recorder = await app.startCodegen();
    const q = app.locator('#qmlWindow');
    await q.locator('#usernameField').fill('admin');
    await q.locator('#newTodoField').fill('Recorded');
    await q.locator('#addButton').click();
    await q.locator('#todoList').getByText('Fix bugs').dblclick();
    await q.locator('#fruitCombo').selectOption('Cherry');
    await q.locator('#draggable').dragBy(100, 0);
    await recorder.stop();

    const lines = recorder.lines();
    expect(lines.slice(0, 5)).toEqual([
      "await app.getByRole('textbox', { name: 'User name' }).fill('admin');",
      "await app.getByRole('textbox', { name: 'New todo' }).fill('Recorded');",
      // without test id, an ambiguous role + name is scoped to its window
      "await app.locator('#qmlWindow').getByRole('button', { name: 'Add' }).click();",
      "await app.getByRole('listitem', { name: 'Fix bugs' }).dblclick();",
      "await app.locator('#fruitCombo').selectOption('Cherry');",
    ]);
    expect(lines[5]).toMatch(/^await app\.locator\('#draggable'\)\.dragBy\(100, 0, \{ sourcePosition: \{ x: \d+, y: \d+ \} \}\);$/);
  });

  test('generated code replays on a fresh instance', async ({ app }) => {
    const recorder = await app.startCodegen();
    const w = app.locator('#widgetsWindow');
    await w.locator('#username').fill('admin');
    await w.locator('#password').fill('secret');
    await w.locator('#loginButton').click();
    await app.locator('#qmlWindow >> #newTodoField').fill('Replayed');
    await app.locator('#qmlWindow >> #addButton').click();
    await recorder.stop();

    const fresh = await launch(test.info().project.use.qtApp!.executable);
    try {
      await replay(fresh, recorder.lines());
      await expect(fresh.locator('#widgetsWindow >> #statusLabel')).toHaveText('Welcome, admin!');
      await expect(fresh.locator('#qmlWindow >> #todoList').getByText('Replayed')).toBeVisible();
    } finally {
      await fresh.close();
    }
  });
});
