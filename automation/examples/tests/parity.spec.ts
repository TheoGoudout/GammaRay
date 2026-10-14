// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { writeFileSync } from 'node:fs';
import { expect, test } from 'qt-playwright/test';

// Playwright APIs adapted to Qt: role/label/placeholder/title/test-id locators, filter/and/or,
// evaluate, low-level mouse/keyboard/touch, selectOption, dialogs, file choosers,
// ARIA snapshots, screenshot assertions and tracing.

test.describe('getBy* locators', () => {
  test('getByRole with name and states, on Widgets and Qt Quick', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    await expect(w.getByRole('button', { name: 'Login' })).toBeDisabled();
    await expect(w.getByRole('checkbox', { name: 'remember' })).toHaveId('rememberMe');
    await expect(w.getByRole('checkbox', { name: 'Remember me', checked: false })).toHaveCount(1);
    await expect(w.getByRole('textbox')).toHaveCount(4); // user, password, new item, serial
    await expect(w.getByRole('slider')).toHaveId('volumeSlider');
    await expect(w.getByRole('combobox')).toHaveId('colorCombo');

    const q = app.locator('#qmlWindow');
    const login = q.getByRole('button', { name: 'Login', exact: true });
    await expect(login).toHaveId('loginButton');
    await expect(login).toHaveAccessibleDescription('Sign in with your account');
    await expect(q.getByRole('button', { name: /^(Add|Clear all)$/ })).toHaveCount(2);
    await expect(q.getByRole('checkbox', { name: 'Remember me' })).toHaveRole('checkbox');
    // explicit Accessible.role / Accessible.name on a plain Rectangle
    await expect(q.getByRole('button', { name: 'Touch target' })).toHaveId('tapArea');
    // hidden elements (the closed dialog's buttons) only with includeHidden
    const all = await q.getByRole('button', { includeHidden: true }).count();
    expect(all).toBeGreaterThan(await q.getByRole('button').count());
  });

  test('getByLabel, getByPlaceholder, getByTitle, getByTestId', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    // QFormLayout labels are the inputs' buddies
    await w.getByLabel('User:').fill('admin');
    await expect(w.locator('#username')).toHaveValue('admin');
    await expect(w.getByLabel('password', { exact: false })).toHaveId('password');
    await expect(w.getByLabel('Serial:')).not.toBeEditable();
    await expect(w.getByLabel('User:')).toBeEditable();
    await expect(w.getByPlaceholder('user name')).toHaveId('username');
    await expect(w.getByTitle('Log in with')).toHaveId('loginButton');
    await expect(w.getByTestId('statusLabel')).toHaveText('Please log in');
    await expect(w.getByTestId(/^(username|password)$/)).toHaveCount(2);

    const q = app.locator('#qmlWindow');
    await q.getByPlaceholder('New todo', { exact: true }).fill('Via placeholder');
    await expect(q.locator('#newTodoField')).toHaveText('Via placeholder');
    await expect(q.getByLabel('Remember me')).toHaveId('rememberCheck');
  });

  test('filter, has, hasText, and, or', async ({ app }) => {
    const q = app.locator('#qmlWindow');
    // the ComboBox popup has ItemDelegates too: scope to the list
    const rows = q.locator('#todoList >> ItemDelegate');
    await expect(rows.filter({ hasText: 'bugs' })).toHaveText('Fix bugs');
    await expect(rows.filter({ hasNotText: /tests|bugs/ })).toHaveText('Ship it');
    // groups that contain a password field
    const groups = q.locator('GroupBox');
    await expect(groups).toHaveCount(2);
    await expect(groups.filter({ has: app.locator('TextField[echoMode=Password]') })).toHaveId('loginBox');
    await expect(groups.filter({ hasNot: app.locator('TextField[echoMode=Password]') })).toHaveCount(1);
    // and / or
    const buttons = q.getByRole('button');
    await expect(buttons.and(q.locator('#clearButton'))).toHaveText('Clear all');
    const either = q.locator('#addButton').or(q.locator('#clearButton'));
    await expect(either).toHaveCount(2);
    await expect(either.first()).toHaveText('Add'); // document order
    // locator(sel, { hasText })
    await expect(app.locator('#widgetsWindow').locator('QGroupBox', { hasText: 'Remember' })).toHaveId('loginBox');
  });

  test('describe(description) labels locators in errors', async ({ app }) => {
    const missing = app.locator('#nope').describe('the missing button');
    const error = await missing.click({ timeout: 200 }).catch((e) => e);
    expect(error.message).toContain('the missing button');
  });
});

test.describe('evaluate', () => {
  test('evaluate on QML items and widgets', async ({ app }) => {
    const q = app.locator('#qmlWindow');
    // QML items are evaluated by their own engine: properties, functions, JS values
    expect(await q.locator('#usernameField').evaluate((el, suffix) => el.placeholderText + suffix, '!')).toBe('User name!');
    expect(await q.evaluate((win) => win.addTodo('From evaluate'))).toBe(4);
    expect(await q.locator('#todoList').evaluate((list) => ({ count: list.count, interactive: list.interactive }))).toEqual({
      count: 4,
      interactive: true,
    });
    // widgets: properties, slots and Q_INVOKABLEs are reachable from JavaScript too
    const user = app.locator('#widgetsWindow >> #username');
    await user.evaluate((el) => {
      el.text = 'set from JS';
    });
    await expect(user).toHaveValue('set from JS');
    expect(await app.locator('#widgetsWindow').evaluate((w, items) => w.addItems(items), ['x', 'y'])).toBe(5);
    // evaluateAll and app.evaluate
    expect(await q.locator('#todoList >> ItemDelegate').evaluateAll((els) => els.map((e) => e.text))).toEqual([
      'Write tests',
      'Fix bugs',
      'Ship it',
      'From evaluate',
    ]);
    expect(await app.evaluate(() => qApp.applicationName)).toBe('qtpw-sampleapp');
    // element handles come back as references; locators can be passed in
    const ref = await app.evaluate((el) => el, app.locator('#widgetsWindow >> #statusLabel'));
    expect(ref).toMatchObject({ type: 'QLabel', objectName: 'statusLabel' });
    // errors carry the JavaScript message
    await expect(user.evaluate((el) => el.noSuchFunction())).rejects.toThrow(/TypeError/);
  });
});

test.describe('low-level input', () => {
  test('mouse, keyboard and touchscreen in screen coordinates', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    const box = (await w.locator('#username').boundingBox())!;
    await app.mouse.click(box.x + 10, box.y + box.height / 2);
    await app.keyboard.type('abc');
    await app.keyboard.down('Shift');
    await app.keyboard.press('Home'); // Shift held: selects to the start
    await app.keyboard.up('Shift');
    await app.keyboard.insertText('XYZ'); // replaces the selection, no key events
    await expect(w.locator('#username')).toHaveValue('XYZ');

    // drag the slider handle with raw mouse moves
    const slider = (await w.locator('#volumeSlider').boundingBox())!;
    await app.mouse.move(slider.x + 4, slider.y + slider.height / 2);
    await app.mouse.down();
    await app.mouse.move(slider.x + slider.width, slider.y + slider.height / 2, { steps: 10 });
    await app.mouse.up();
    await expect(w.locator('#volumeSlider')).toHaveProperty('value', 100);

    // wheel at the pointer position
    const list = (await w.locator('#longList').boundingBox())!;
    await app.mouse.move(list.x + 30, list.y + 30);
    await app.mouse.wheel(0, 240);
    await expect(w.locator('#longList >> QScrollBar[orientation=Vertical]')).not.toHaveProperty('value', 0);

    // touch: the QML TapHandler only accepts touch screens
    const tap = (await app.locator('#qmlWindow >> #tapArea').boundingBox())!;
    await app.touchscreen.tap(tap.x + 10, tap.y + 10);
    await expect(app.locator('#qmlWindow >> #tapLabel')).toHaveText('Tapped by touch');
  });

  test('tap, blur, selectText, click delay, trial and pressSequentially delay', async ({ app }) => {
    const q = app.locator('#qmlWindow');
    await q.locator('#tapLabel').tap();
    await expect(q.locator('#tapLabel')).toHaveText('Tapped by touch');

    const field = q.locator('#usernameField');
    await field.pressSequentially('slow', { delay: 30 });
    await expect(field).toHaveValue('slow');
    await field.selectText();
    await app.keyboard.press('Backspace');
    await expect(field).toBeEmpty();
    await expect(field).toBeFocused();
    await field.blur();
    await expect(field).not.toBeFocused();

    // trial runs the actionability checks only
    const todos = q.locator('#todoList >> ItemDelegate');
    await q.locator('#newTodoField').fill('held');
    await q.locator('#addButton').click({ trial: true });
    await expect(todos).toHaveCount(3);
    await q.locator('#addButton').click({ delay: 150 });
    await expect(todos).toHaveCount(4);
    // dispatchEvent emits the signal directly (no input, no actionability checks)
    await q.locator('#newTodoField').fill('dispatched');
    await q.locator('#addButton').dispatchEvent('clicked');
    await expect(todos).toHaveCount(5);
  });
});

test.describe('forms and dialogs', () => {
  test('selectOption on QComboBox and QML ComboBox (real popups)', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    expect(await w.locator('#colorCombo').selectOption('Blue')).toEqual(['Blue']);
    // the app only reacts to user activation (QComboBox::activated)
    await expect(w.locator('#colorLabel')).toHaveText('Color: Blue (b)');
    await w.locator('#colorCombo').selectOption({ value: 'g' });
    await expect(w.locator('#colorLabel')).toHaveText('Color: Green (g)');
    await w.locator('#colorCombo').selectOption({ index: 0 });
    await expect(w.locator('#colorCombo')).toHaveProperty('currentText', 'Red');
    await expect(w.locator('#colorCombo').selectOption('Purple')).rejects.toThrow(/options are: Red, Green, Blue/);

    const q = app.locator('#qmlWindow');
    expect(await q.locator('#fruitCombo').selectOption('Cherry')).toEqual(['Cherry']);
    await expect(q.locator('#fruitLabel')).toHaveText('Fruit: Cherry');
    await q.locator('#fruitCombo').selectOption({ index: 1 });
    await expect(q.locator('#fruitLabel')).toHaveText('Fruit: Banana');
  });

  test('message boxes: waitForEvent("dialog") and on("dialog")', async ({ app }) => {
    const w = app.locator('#widgetsWindow');
    await w.locator('#username').fill('someone');

    const dialogPromise = app.waitForEvent('dialog');
    await w.locator('#resetButton').click();
    const dialog = await dialogPromise;
    expect(dialog.type()).toBe('messagebox');
    expect(await dialog.message()).toBe('Reset the login form?');
    expect(await dialog.title()).toBe('Reset');
    await dialog.dismiss();
    await expect(w.locator('#statusLabel')).toHaveText('Reset cancelled');
    await expect(w.locator('#username')).toHaveValue('someone');

    // handler style: accept every dialog
    const seen: string[] = [];
    const handler = async (d: import('qt-playwright').Dialog) => {
      seen.push(await d.message());
      await d.accept();
    };
    app.on('dialog', handler);
    await w.locator('#resetButton').click();
    await expect(w.locator('#statusLabel')).toHaveText('Form reset');
    await expect(w.locator('#username')).toHaveValue('');
    app.off('dialog', handler);
    expect(seen).toEqual(['Reset the login form?']);

    // Qt Quick dialogs work the same way
    await app.locator('#qmlWindow >> #clearButton').click();
    const quick = await app.waitForDialog();
    expect(await quick.title()).toBe('Confirm');
    await quick.accept();
    await expect(app.locator('#qmlWindow >> #todoList >> ItemDelegate')).toHaveCount(0);
  });

  test('file dialogs: setInputFiles and waitForEvent("filechooser")', async ({ app }, testInfo) => {
    const file = testInfo.outputPath('input.txt');
    writeFileSync(file, 'hello');
    const w = app.locator('#widgetsWindow');

    await w.locator('#fileButton').setInputFiles(file);
    await expect(w.locator('#fileLabel')).toHaveText(`File: ${file}`);

    const chooserPromise = app.waitForEvent('filechooser');
    await w.getByRole('button', { name: 'Choose file' }).click();
    const chooser = await chooserPromise;
    expect(await chooser.isMultiple()).toBe(false);
    await chooser.setFiles(file);
    await expect(w.locator('#fileLabel')).toContainText('input.txt');
  });
});

test.describe('snapshots, screenshots, traces', () => {
  test('ariaSnapshot and toMatchAriaSnapshot', async ({ app }) => {
    const login = app.locator('#qmlWindow >> #loginBox');
    const snapshot = await login.ariaSnapshot();
    expect(snapshot).toContain('- textbox "User name"');
    expect(snapshot).toContain('- button "Login" [disabled]');

    await app.locator('#qmlWindow >> #usernameField').fill('admin');
    await expect(login).toMatchAriaSnapshot(`
      - group "Login":
        - textbox "User name": admin
        - checkbox "Remember me"
        - button "Login" [disabled]
        - text: Please log in
    `);
    // partial templates and regexes
    await expect(app.locator('#widgetsWindow >> #loginBox')).toMatchAriaSnapshot(`
      - textbox /User/
      - button "Login"
    `);
    await expect(app).toMatchAriaSnapshot(`
      - window "QML Demo"
    `);
    await expect(app).toHaveTitle('Widgets Demo');
  });

  test('toHaveScreenshot with masks', async ({ app }) => {
    // a widget whose rendering does not depend on fonts, so the baseline is portable
    await expect(app.locator('#qmlWindow >> #draggable')).toHaveScreenshot('draggable.png');
    await app.locator('#qmlWindow >> #draggable').setProperty('color', 'blue');
    await expect(app.locator('#qmlWindow >> #draggable')).not.toHaveProperty('color', '#ffa500');
    // masking paints over elements, here the whole item
    await expect(app.locator('#qmlWindow >> #draggable')).toHaveScreenshot('draggable-masked.png', {
      mask: [app.locator('#qmlWindow >> #draggable')],
    });
  });

  test('viewport and emptiness', async ({ app }) => {
    const q = app.locator('#qmlWindow');
    await expect(q.locator('#longList').getByText('Row 0', { exact: true })).toBeInViewport();
    await q.locator('#longList').evaluate((list) => list.positionViewAtEnd());
    await expect(q.locator('#longList').getByText('Row 0', { exact: true })).not.toBeInViewport();
    await expect(q.locator('#newTodoField')).toBeEmpty();
    await expect(q.locator('#statusLabel')).not.toBeEmpty();
    await expect(q.locator('#loginButton')).toHaveClass('Button');
    await expect(q.locator('#loginButton')).toHaveAttribute('text', 'Login');
    await expect(q.locator('#loginButton')).toHaveJSProperty('flat', false);
    expect(await q.locator('#usernameField').isEditable()).toBe(true);
    expect(await app.locator('#widgetsWindow >> #serialField').isEditable()).toBe(false);
    expect(await q.locator('#loginButton').getAttribute('text')).toBe('Login');
    expect(await q.locator('#loginButton').getAttribute('noSuchProperty')).toBeNull();
  });

  test('tracing records actions, errors and screenshots', async ({ app }, testInfo) => {
    await app.tracing.start({ title: 'login trace' });
    const w = app.locator('#widgetsWindow');
    await w.getByLabel('User:').fill('admin');
    await w.getByLabel('Password:').fill('secret');
    await w.getByRole('button', { name: 'Login' }).click();
    await w.locator('#nope').click({ timeout: 100 }).catch(() => undefined);
    const path = testInfo.outputPath('trace.html');
    const html = (await app.tracing.stop({ path })).toString();
    expect(html).toContain('login trace');
    expect(html).toContain('fill');
    expect(html).toContain('Timeout 100ms exceeded');
    expect(html.match(/data:image\/jpeg;base64/g)!.length).toBeGreaterThanOrEqual(4);
    await testInfo.attach('trace', { path, contentType: 'text/html' });
  });
});
