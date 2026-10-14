// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { expect, test } from 'qt-playwright/test';

// ListView delegates (visual-tree children) and a modal Qt Quick Controls Dialog (a
// popup living in the window overlay).

test.describe('QML list and modal dialog', () => {
  test('delegates are addressable and update with the model', async ({ app }) => {
    const win = app.locator('#qmlWindow');
    const todos = win.locator('#todoList >> ItemDelegate');
    await expect(todos).toHaveCount(3);
    await expect(todos.first()).toHaveText('Write tests');

    await win.locator('#newTodoField').fill('Review');
    await win.locator('#addButton').click();
    await expect(todos).toHaveCount(4);
    await expect(todos.last()).toHaveText('Review');

    expect(await win.invoke('addTodo', 'From JS')).toBe(5);
    await expect(win.locator('#todoList').getByText('From JS')).toBeVisible();
  });

  test('clicking and double-clicking delegates', async ({ app }) => {
    const win = app.locator('#qmlWindow');
    const second = win.locator('#todoList').getByText('Fix bugs');
    await second.click();
    await expect(win.locator('#todoList')).toHaveProperty('currentIndex', 1);
    await expect(second).toHaveProperty('highlighted', true);
    await second.dblclick();
    await expect(win.locator('#statusLabel')).toHaveText('Opened: Fix bugs');
  });

  test('modal dialog blocks the window until accepted', async ({ app }) => {
    const win = app.locator('#qmlWindow');
    await win.locator('#clearButton').click();

    const dialog = win.locator('Dialog#confirmDialog');
    await expect(dialog).toHaveProperty('opened', true);
    // dialog contents are found below the popup even though they live in the overlay
    await expect(dialog.locator('#confirmText')).toHaveText('Remove all 3 todos?');
    await expect(dialog.locator('#confirmText')).toBeVisible();

    await expect(win.locator('#addButton').click({ timeout: 500 })).rejects.toThrow(/modal popup/);

    await dialog.getByText('OK').click();
    await expect(dialog).toHaveProperty('visible', false);
    await expect(win.locator('#todoList >> ItemDelegate')).toHaveCount(0);
  });

  test('Escape rejects the dialog', async ({ app }) => {
    const win = app.locator('#qmlWindow');
    await win.locator('#clearButton').click();
    await expect(win.locator('#confirmText')).toBeVisible();
    await app.press('Escape');
    await expect(win.locator('#confirmText')).toBeHidden();
    await expect(win.locator('#todoList >> ItemDelegate')).toHaveCount(3);
  });
});
