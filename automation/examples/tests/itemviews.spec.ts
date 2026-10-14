// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import path from 'node:path';
import { expect, launch, test, type QtApp } from 'qt-playwright/test';

// Model/view rows as elements: QListView/QTreeView/QTableView rows have no QObjects, yet they
// can be located by role and name, clicked, checked, selected and asserted like any element.

const sampleApp = process.env.QTPW_SAMPLEAPP ?? path.resolve(__dirname, '../sampleapp/build/sampleapp');

test.use({ qtApp: { executable: sampleApp, args: ['--data', '--widgets-only'] } });

test.describe('item view rows', () => {
  test('tree rows: expand, check and double-click', async ({ app }) => {
    const tree = app.locator('#fileTree');
    const documents = tree.getByRole('treeitem', { name: 'Documents' });
    await expect(documents).toBeVisible();
    await expect(documents).toHaveAttribute('expanded', 'false');
    // children of a collapsed row exist but are hidden, like collapsed DOM content
    await expect(tree.getByRole('treeitem', { name: 'report.pdf' })).toBeHidden();

    await documents.dblclick();
    await expect(app.locator('#dataStatus')).toHaveText('Opened Documents');
    await expect(documents).toHaveProperty('expanded', true);
    const report = documents.getByRole('treeitem', { name: 'report.pdf' });
    await expect(report).toBeVisible();

    // check() clicks the row's check indicator
    await report.check();
    await expect(report).toBeChecked();
    await expect(app.locator('#dataStatus')).toHaveText('report.pdf checked');
    await report.uncheck();
    await expect(report).not.toBeChecked();

    // writable properties: expand a branch without clicking
    await tree.getByRole('treeitem', { name: 'Pictures' }).setProperty('expanded', true);
    await expect(tree.getByRole('treeitem', { level: 2 })).toHaveCount(5);
    await expect(tree.getByRole('treeitem', { name: 'dog.png' })).toHaveProperty('cells', ['dog.png', '21 KB']);
  });

  test('table rows and cells', async ({ app }) => {
    const table = app.locator('#peopleTable');
    await expect(table.getByRole('row')).toHaveCount(4);
    // a row's accessible name is the text of its cells
    const bob = table.getByRole('row', { name: 'Bob 27 Paris' });
    await bob.click();
    await expect(app.locator('#dataStatus')).toHaveText('Selected Bob');
    await expect(bob).toHaveAttribute('selected');
    await expect(table).toHaveValues(['Bob']);

    const carol = table.getByRole('row').filter({ hasText: 'Carol' });
    await expect(carol.getByRole('cell')).toHaveText(['Carol', '45', 'Oslo']);
    await expect(carol.getByRole('cell').nth(1)).toHaveText('45');
    await table.getByRole('cell', { name: 'Rome' }).click();
    await expect(app.locator('#dataStatus')).toHaveText('Selected Dave');
  });

  test('multi-selection lists: selectOption and toHaveValues', async ({ app }) => {
    const tags = app.locator('#tagList');
    expect(await tags.selectOption(['green', 'blue'])).toEqual(['green', 'blue']);
    await expect(tags).toHaveValues(['green', 'blue']);
    await expect(app.locator('#dataStatus')).toHaveText('Tags: blue, green');
    await expect(tags.getByRole('listitem', { selected: true })).toHaveCount(2);

    await tags.selectOption({ index: 0 });
    await expect(tags).toHaveValues(['red']);

    // rows scrolled out of view are scrolled into view before clicking
    const purple = tags.getByRole('listitem', { name: 'purple' });
    await purple.check();
    await expect(purple).toBeChecked();
    await expect(purple).toBeInViewport();
    await expect(purple).toHaveAccessibleDescription('The color purple');
    await expect(tags).toMatchAriaSnapshot(`
      - listitem "red" [selected]
      - listitem "purple" [checked]
    `);
  });

  test('toHaveCSS: style sheets, palettes and fonts', async ({ app }) => {
    const warning = app.locator('#warningLabel');
    await expect(warning).toHaveCSS('color', '#c00000');
    await expect(warning).toHaveCSS('background-color', 'rgb(255, 240, 200)');
    await expect(warning).toHaveCSS('font-size', '18px');
    await expect(warning).toHaveCSS('font-weight', '700');
    const hint = app.locator('#hintLabel');
    await expect(hint).toHaveCSS('color', 'blue');
    await expect(hint).toHaveCSS('font-style', 'italic');
    await expect(hint).toHaveCSS('background-color', 'transparent');
    await expect(hint).not.toHaveCSS('font-weight', '700');
    const style = await warning.computedStyle();
    expect(style.visibility).toBe('visible');
    expect(style.width).toMatch(/^\d+px$/);
  });
});

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
async function replay(app: QtApp, lines: string[]): Promise<void> {
  await new AsyncFunction('app', lines.join('\n'))(app);
}

test.describe('item view codegen', () => {
  test('records rows by role and name, check boxes, modifiers and tree arrows', async ({ app }) => {
    const recorder = await app.startCodegen();
    const tags = app.locator('#tagList');
    await tags.getByRole('listitem', { name: 'green' }).click();
    await tags.getByRole('listitem', { name: 'yellow' }).click({ modifiers: ['Control'] });
    await tags.getByRole('listitem', { name: 'red' }).check();
    // the expand arrow of a tree row is left of the row's rectangle
    await app.getByRole('treeitem', { name: 'Pictures' }).click({ position: { x: -10, y: 8 } });
    await app.getByRole('treeitem', { name: 'cat.png' }).dblclick();
    await app.getByRole('cell', { name: 'Oslo' }).click();
    await recorder.stop();

    expect(recorder.lines()).toEqual([
      "await app.getByRole('listitem', { name: 'green' }).click();",
      "await app.getByRole('listitem', { name: 'yellow' }).click({ modifiers: ['Control'] });",
      "await app.getByRole('listitem', { name: 'red' }).check();",
      "await app.getByRole('treeitem', { name: 'Pictures' }).click({ position: { x: -10, y: 8 } });",
      "await app.getByRole('treeitem', { name: 'cat.png' }).dblclick();",
      "await app.getByRole('cell', { name: 'Oslo' }).click();",
    ]);

    const fresh = await launch(test.info().project.use.qtApp?.executable ?? sampleApp, ['--data', '--widgets-only']);
    try {
      await replay(fresh, recorder.lines().slice(0, 5));
      await expect(fresh.locator('#tagList')).toHaveValues(['green', 'yellow']);
      await expect(fresh.getByRole('listitem', { name: 'red' })).toBeChecked();
      await expect(fresh.getByRole('treeitem', { name: 'Pictures' })).toHaveProperty('expanded', true);
      await expect(fresh.locator('#dataStatus')).toHaveText('Opened cat.png');
    } finally {
      await fresh.close();
    }
  });
});

test.describe('Qt Quick styles', () => {
  test.use({
    qtApp: { executable: sampleApp, args: ['--qml-only'] },
  });

  test('toHaveCSS on QML items', async ({ app }) => {
    const hoverArea = app.locator('#hoverArea');
    await expect(hoverArea).toHaveCSS('background-color', 'lightgray');
    await hoverArea.hover();
    await expect(hoverArea).toHaveCSS('background-color', 'lightsteelblue');
    await expect(app.locator('#draggable')).toHaveCSS('background-color', 'orange');
    await expect(app.locator('#draggable')).toHaveCSS('width', '50px');
    await expect(app.locator('#statusLabel')).toHaveCSS('opacity', '1');
  });
});
