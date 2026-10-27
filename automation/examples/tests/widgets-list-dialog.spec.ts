// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { expect, test } from 'qt-playwright/test';

// List manipulation and a modal QDialog::exec() (nested event loop): the app stays
// scriptable while the dialog is open, and input to the blocked main window is refused.

test.describe('widgets list and modal dialog', () => {
  test('adds items through the UI and via invokable methods', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    const list = w.locator('#itemList');
    await expect(list).toHaveProperty('count', 3);

    await w.locator('#newItem').fill('Durian');
    await w.locator('#addButton').click();
    await expect(list).toHaveProperty('count', 4);
    await expect(w.locator('#newItem')).toHaveText('');

    // Q_INVOKABLE with a QStringList argument and an int return value
    expect(await w.invoke('addItems', ['Elderberry', 'Fig'])).toBe(6);
    await expect(list).toHaveProperty('count', 6);
  });

  test('removing an item asks for confirmation in a modal dialog', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    const list = w.locator('#itemList');
    await list.setProperty('currentRow', 1); // "Banana" (a writable Q_PROPERTY)

    await w.locator('#removeButton').click();

    // the dialog is a child of the window; its exec() runs a nested event loop
    const dialog = w.locator('#confirmDialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#confirmText')).toHaveText("Remove 'Banana'?");

    // the main window is blocked by the modal dialog: the click never becomes actionable
    await expect(w.locator('#addButton').click({ timeout: 500 })).rejects.toThrow(/modal window/);

    await dialog.getByText('OK').click();
    await expect(dialog).toHaveCount(0); // destroyed after exec() returned
    await expect(list).toHaveProperty('count', 2);
    expect(await list.getProperty('currentRow')).toBe(1);
  });

  test('cancelling the dialog keeps the item', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    await w.locator('#itemList').setProperty('currentRow', 0);
    await w.locator('#removeButton').click();
    const dialog = await app.waitForObject('#widgetsWindow >> #confirmDialog');
    await dialog.getByText('Cancel').click();
    await expect(dialog).toBeHidden();
    await expect(w.locator('#itemList')).toHaveProperty('count', 3);
  });

  test('a slot that runs the dialog keeps the application scriptable', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    await w.locator('#itemList').setProperty('currentRow', 0);
    // invoke() returns when the slot does, i.e. after the dialog's exec(); meanwhile the
    // connection keeps working and drives the dialog
    const invoked = w.locator('#removeButton').invoke('click');
    const dialog = w.locator('#confirmDialog');
    await expect(dialog).toBeVisible();
    await dialog.getByText('OK').click();
    await invoked;
    await expect(dialog).toBeHidden();
    await expect(w.locator('#itemList')).toHaveProperty('count', 2);
  });

  test('escape closes the dialog', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    await w.locator('#itemList').setProperty('currentRow', 0);
    await w.locator('#removeButton').click();
    await expect(w.locator('#confirmDialog')).toBeVisible();
    await app.press('Escape');
    await expect(w.locator('#confirmDialog')).toHaveCount(0);
  });

  test('double-clicking a row opens it', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    // model rows are not QObjects: address them by position inside the view's viewport
    const viewport = w.locator('#itemList >> QWidget[objectName="qt_scrollarea_viewport"]');
    await viewport.dblclick({ position: { x: 20, y: 8 } });
    await expect(w.locator('#statusLabel')).toHaveText('Opened: Apple');
  });
});
