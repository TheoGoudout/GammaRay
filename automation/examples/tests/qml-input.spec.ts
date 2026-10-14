// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { expect, test } from 'qt-playwright/test';

// Pointer and keyboard input on Qt Quick: HoverHandler, DragHandler, Slider, Flickable
// wheel scrolling, keyboard focus, screenshots of items.

test.describe('QML input', () => {
  test('hover is seen by HoverHandler', async ({ app }) => {
    const label = app.locator('#qmlWindow >> #hoverLabel');
    await expect(label).toHaveText('Not hovered');
    await app.locator('#qmlWindow >> #hoverArea').hover();
    await expect(label).toHaveText('Hovered');
  });

  test('DragHandler moves an item', async ({ app }) => {
    const box = app.locator('#qmlWindow >> #draggable');
    await expect(box).toHaveProperty('x', 0);
    await box.dragBy(120, 0);
    const x = await box.getProperty<number>('x');
    expect(x).toBeGreaterThan(100);
    expect(x).toBeLessThanOrEqual(120);
    // colors are reported as #rrggbb
    await expect(box).toHaveProperty('color', '#ffa500');
  });

  test('Slider via drag and keyboard', async ({ app }) => {
    const slider = app.locator('#qmlWindow >> #volumeSlider');
    const label = app.locator('#qmlWindow >> #volumeLabel');
    const target = app.locator('#qmlWindow >> #volumeLabel');
    // drag the handle all the way to the right, onto the label
    await slider.dragTo(target, { sourcePosition: { x: 8, y: 20 } });
    await expect(slider).toHaveProperty('value', 100);
    await expect(label).toHaveText('Volume: 100');

    await slider.press('ArrowLeft');
    await slider.press('ArrowLeft');
    await expect(slider).toHaveProperty('value', 98);
    await slider.press('ArrowUp'); // ignored by a horizontal Slider
    await slider.press('ArrowLeft');
    await expect(label).toHaveText('Volume: 97');

    await slider.setProperty('value', 25);
    await expect(label).toHaveText('Volume: 25');
  });

  test('mouse wheel scrolls a ListView', async ({ app }) => {
    const list = app.locator('#qmlWindow >> #longList');
    await expect(list).toHaveProperty('contentY', 0);
    await expect(list.getByText('Row 40')).toHaveCount(0); // not instantiated yet
    for (let i = 0; i < 5; ++i) await list.scroll({ deltaY: 360 });
    await expect.poll(() => list.getProperty<number>('contentY')).toBeGreaterThan(100);
    await expect(list.locator('text=/^Row [1-9][0-9]$/').first()).toBeVisible();
  });

  test('screenshots of items and windows', async ({ app }, testInfo) => {
    const button = app.locator('#qmlWindow >> #loginButton');
    const png = await button.screenshot({ path: testInfo.outputPath('qml-button.png') });
    const box = (await button.boundingBox())!;
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(Math.round(box.width));
    expect(png.readUInt32BE(20)).toBe(Math.round(box.height));

    const win = await app.locator('#qmlWindow').screenshot();
    expect(win.readUInt32BE(16)).toBe(460);
    expect(win.readUInt32BE(20)).toBe(760);
  });
});
