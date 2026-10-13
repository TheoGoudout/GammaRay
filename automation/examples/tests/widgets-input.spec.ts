// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { expect, test } from 'qt-playwright/test';

// Pointer and keyboard input on QtWidgets: hover, drag, wheel, keys; screenshots;
// object creation/destruction events.

test.describe('widgets input', () => {
  test('hover moves the mouse over an element', async ({ app }) => {
    const hover = app.locator('#widgetsWindow >> #hoverLabel');
    await expect(hover).toHaveText('Not hovered');
    await hover.hover();
    await expect(hover).toHaveText('Hovered');
    await app.locator('#widgetsWindow >> #statusLabel').hover();
    await expect(hover).toHaveText('Not hovered');
  });

  test('dragging the slider handle changes the value', async ({ app }) => {
    const slider = app.locator('#widgetsWindow >> #volumeSlider');
    const box = (await slider.boundingBox())!;
    // grab the handle at the left end and drag it to the middle
    await slider.dragBy(box.width / 2, 0, { sourcePosition: { x: 5, y: box.height / 2 } });
    const value = await slider.getProperty<number>('value');
    expect(value).toBeGreaterThan(30);
    expect(value).toBeLessThan(70);
    await expect(app.locator('#widgetsWindow >> #volumeLabel')).toHaveText(`Volume: ${value}`);
  });

  test('keyboard input on a focused slider', async ({ app }) => {
    const slider = app.locator('#widgetsWindow >> #volumeSlider');
    await slider.press('End');
    await expect(slider).toHaveProperty('value', 100);
    await slider.press('ArrowLeft');
    await expect(slider).toHaveProperty('value', 99);
    await slider.press('Home');
    await expect(app.locator('#widgetsWindow >> #volumeLabel')).toHaveText('Volume: 0');
    await expect(slider).toBeFocused();
  });

  test('setProperty drives the UI', async ({ app }) => {
    await app.locator('#widgetsWindow >> #volumeSlider').setProperty('value', 42);
    await expect(app.locator('#widgetsWindow >> #volumeLabel')).toHaveText('Volume: 42');
  });

  test('mouse wheel scrolls a list', async ({ app }) => {
    const list = app.locator('#widgetsWindow >> #longList');
    // enum-valued property filter: the vertical scroll bar
    const scrollBar = list.locator('QScrollBar[orientation=Vertical]');
    await expect(scrollBar).toHaveProperty('value', 0);
    await list.scroll({ deltaY: 240 }); // two wheel notches down
    await expect(scrollBar).not.toHaveProperty('value', 0);
    const value = await scrollBar.getProperty<number>('value');
    await list.scroll({ deltaY: -240 });
    await expect(scrollBar).toHaveProperty('value', 0);
    expect(value).toBeGreaterThan(0);
  });

  test('screenshots of windows and elements', async ({ app }, testInfo) => {
    const window = app.locator('#widgetsWindow');
    const shot = await window.screenshot({ path: testInfo.outputPath('widgets-window.png') });
    expect(shot.subarray(1, 4).toString()).toBe('PNG');
    expect(shot.readUInt32BE(16)).toBe(460); // IHDR width

    const button = await window.locator('#loginButton').screenshot();
    const box = (await window.locator('#loginButton').boundingBox())!;
    expect(button.readUInt32BE(16)).toBe(box.width);
    expect(button.readUInt32BE(20)).toBe(box.height);

    const whole = await window.locator('#loginButton').screenshot({ window: true });
    expect(whole.readUInt32BE(16)).toBe(460);
    await testInfo.attach('login-button', { body: button, contentType: 'image/png' });
  });

  test('object created/destroyed events', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    const created: string[] = [];
    const destroyed: number[] = [];
    const stopCreated = await app.onObjectCreated((els) => created.push(...els.map((e) => e.objectName ?? e.type)));
    const stopDestroyed = await app.onObjectDestroyed((handles) => destroyed.push(...handles));

    await w.locator('#itemList').setProperty('currentRow', 0);
    await w.locator('#removeButton').click();
    const dialog = await app.waitForObject('#widgetsWindow >> #confirmDialog >> #confirmText');
    const dialogHandle = await w.locator('#confirmDialog').handle();
    expect(created).toContain('confirmDialog');

    await w.locator('#confirmDialog').getByText('Cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => destroyed.includes(dialogHandle)).toBe(true);
    await stopCreated();
    await stopDestroyed();
  });
});
