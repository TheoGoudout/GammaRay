// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, launch, runServer, test, type RunningServer } from 'qt-playwright/test';
import { createMcpServer, McpContext, runMcpServer } from 'qt-playwright/mcp';

// The MCP server, driven by an MCP client the way an AI agent does: snapshots with refs,
// actions on refs and locators, assertions, dialogs, screenshots and test generation, over
// stdio (the CLI), Streamable HTTP with a remote application, and connected to a running app.

const sampleApp = process.env.QTPW_SAMPLEAPP ?? path.resolve(__dirname, '../sampleapp/build/sampleapp');
const cli = path.join(path.dirname(require.resolve('qt-playwright')), 'cli.js');

interface ToolOutput {
  text: string;
  isError: boolean;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

function tools(client: Client) {
  return async (name: string, args: Record<string, unknown> = {}): Promise<ToolOutput> => {
    const r = (await client.callTool({ name, arguments: args })) as { content: ToolOutput['content']; isError?: boolean };
    return { content: r.content, isError: !!r.isError, text: r.content.map((c) => c.text ?? '').join('\n') };
  };
}

/** The ref of the first snapshot line matching @p line, e.g. /textbox "User:"/. */
function ref(snapshot: string, line: RegExp): string {
  const found = snapshot.split('\n').find((l) => line.test(l));
  const m = found && /\[ref=(e\d+)\]/.exec(found);
  if (!m) throw new Error(`no element matching ${line} in the snapshot:\n${snapshot}`);
  return m[1];
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

test('stdio: an agent explores the app, tests it live and gets a test file', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const outputDir = testInfo.outputPath('mcp');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', '--app', sampleApp, '--args', '--widgets-only', '--headless', '--output-dir', outputDir],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);
  const call = tools(client);
  let pid = 0;
  try {
    expect(client.getServerVersion()?.name).toBe('qt-playwright');
    const { tools: list } = await client.listTools();
    expect(list.map((t) => t.name)).toEqual(expect.arrayContaining(['qt_launch', 'qt_snapshot', 'qt_click', 'qt_expect', 'qt_generate_test']));

    // the first tool that needs an application launches the configured one
    const first = await call('qt_snapshot');
    expect(first.isError, first.text).toBe(false);
    expect(first.text).toContain('qtpw-sampleapp');
    expect(first.text).toMatch(/- generic "Widgets Demo" \[ref=e\d+\]:/);
    pid = Number(/pid (\d+)/.exec(first.text)![1]);
    // long lists are shortened; a snapshot of the element shows all of it
    const more = /# \.\.\. 80 more: qt_snapshot with ref (e\d+) lists all/.exec(first.text);
    expect(more, first.text).toBeTruthy();
    expect(first.text).not.toContain('"Row 99"');
    const all = await call('qt_snapshot', { ref: more![1] });
    expect(all.text).toContain('listitem "Row 99"');

    // act on refs from the snapshot, or on locator expressions
    const typed = await call('qt_type', { element: 'User field', ref: ref(first.text, /textbox "User:"/), text: 'admin' });
    expect(typed.text).toContain("await app.getByRole('textbox', { name: 'User:' }).fill('admin');");
    expect(typed.text).toMatch(/textbox "User:" \[ref=e\d+\]: admin/); // the snapshot after the action
    await call('qt_type', { locator: "getByLabel('Password:')", text: 'secret' });
    const clicked = await call('qt_click', { element: 'Login button', ref: ref(typed.text, /button "Login"/) });
    expect(clicked.isError, clicked.text).toBe(false);
    expect(clicked.text).toContain('Welcome, admin!');

    // live testing with the retrying assertions
    const passed = await call('qt_expect', { locator: '#statusLabel', assertion: 'toHaveText', expected: 'Welcome, admin!' });
    expect(passed.text).toContain("await expect(app.locator('#statusLabel')).toHaveText('Welcome, admin!');");
    expect((await call('qt_expect', { locator: '#statusLabel', assertion: 'toHaveText', expected: '/^welcome/i' })).isError).toBe(false);
    const failed = await call('qt_expect', { locator: '#statusLabel', assertion: 'toHaveText', expected: 'Goodbye', timeout: 300 });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('Assertion failed');
    expect((await call('qt_expect', { assertion: 'toBeVisible' })).text).toContain('needs a ref or locator');

    // combo boxes are selected through their popup
    const selected = await call('qt_select_option', { locator: "getByRole('combobox', { name: 'Color:' })", values: ['Green'] });
    expect(selected.text).toContain('Color: Green (g)');
    // a modal QMessageBox shows up in the snapshot and is handled like a user would
    const reset = await call('qt_click', { locator: "getByRole('button', { name: 'Reset...' })" });
    expect(reset.text).toContain('Reset the login form?');
    const accepted = await call('qt_handle_dialog', { accept: true });
    expect(accepted.isError, accepted.text).toBe(false);
    expect(accepted.text).toContain('"Reset"');
    expect(accepted.text).toContain('Form reset');

    // observation tools
    const shot = await call('qt_screenshot', { path: 'all.png' });
    const image = shot.content.find((c) => c.type === 'image')!;
    expect(image.mimeType).toBe('image/png');
    expect(Buffer.from(image.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(existsSync(path.join(outputDir, 'all.png'))).toBe(true);
    const inspected = await call('qt_inspect', { locator: '#loginButton' });
    expect(inspected.text).toContain('"objectName": "loginButton"');
    expect(inspected.text).toContain("`app.getByRole('button', { name: 'Login' })`");
    expect(inspected.text).toContain('"toolTip": "Log in with your account"');
    const found = await call('qt_find', { locator: "getByRole('button')" });
    expect(found.text).toMatch(/matches \d+ element\(s\) \(actions need exactly one/);
    const strict = await call('qt_click', { locator: "getByRole('button')" });
    expect(strict.isError).toBe(true);
    expect(strict.text).toContain('strict mode violation');
    expect((await call('qt_status')).text).toContain('GammaRay automation server listening');

    // the session as a test, which passes on a fresh instance
    const generated = await call('qt_generate_test', { name: 'login and reset', path: 'session.spec.ts' });
    const file = readFileSync(path.join(outputDir, 'session.spec.ts'), 'utf8');
    expect(generated.text).toContain(file.trim());
    expect(file).toContain("test('login and reset', async ({ app }) => {");
    expect(file).toContain("await app.getByRole('combobox', { name: 'Color:' }).selectOption('Green');");
    expect(file).toContain('await dialog.accept();');
    expect(generated.text).toContain(`use: { qtApp: { executable: '${sampleApp}', args: ['--widgets-only'] } },`);
    const body = file.slice(file.indexOf('=> {') + 4, file.lastIndexOf('});'));
    const replayed = await launch(sampleApp, ['--widgets-only'], { headless: true });
    try {
      await new AsyncFunction('app', 'expect', body)(replayed, expect);
      await expect(replayed.locator('#statusLabel')).toHaveText('Form reset');
    } finally {
      await replayed.close();
    }

    // closing terminates the launched application
    expect((await call('qt_close')).text).toContain('Closed');
    await expect.poll(() => processExists(pid)).toBe(false);
    const relaunched = await call('qt_snapshot'); // relaunched on demand
    expect(relaunched.isError).toBe(false);
    pid = Number(/pid (\d+)/.exec(relaunched.text)![1]);
  } finally {
    await client.close();
  }
  // the agent going away terminates the application as well
  if (pid) await expect.poll(() => processExists(pid)).toBe(false);
});

test.describe('remote', () => {
  let server: RunningServer;
  test.beforeAll(async () => {
    server = await runServer({ port: 0, token: 'device-secret', gammaray: process.env.QT_PLAYWRIGHT_GAMMARAY, log: () => {} });
  });
  test.afterAll(async () => {
    await server.close();
  });

  test('HTTP: launches on another machine through qt-playwright server, with a token', async () => {
    test.setTimeout(90_000);
    const mcp = await runMcpServer({
      port: 0,
      token: 'mcp-secret',
      remote: { url: server.url, token: 'device-secret' },
      headless: true,
      log: () => {},
    });
    try {
      // a web page cannot use the server (DNS rebinding), and without the token it refuses too
      const fromPage = await fetch(mcp.url!, { method: 'POST', headers: { Origin: 'https://evil.example', Authorization: 'Bearer mcp-secret' } });
      expect(fromPage.status).toBe(403);
      // (fetch() cannot set Host)
      const rebound = await new Promise<number>((resolve, reject) =>
        request(mcp.url!, { method: 'POST', headers: { Host: 'evil.example:80' } }, (res) => resolve(res.statusCode!))
          .on('error', reject)
          .end(),
      );
      expect(rebound).toBe(403);
      const anonymous = new Client({ name: 'e2e', version: '1.0.0' });
      await expect(anonymous.connect(new StreamableHTTPClientTransport(new URL(mcp.url!)))).rejects.toThrow(/401|nauthorized/);

      const client = new Client({ name: 'e2e', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(mcp.url!), { requestInit: { headers: { Authorization: 'Bearer mcp-secret' } } }),
      );
      const call = tools(client);
      const launched = await call('qt_launch', { executable: sampleApp, args: ['--qml-only'] });
      expect(launched.isError, launched.text).toBe(false);
      expect(launched.text).toContain(`on ${server.url}`);
      const pid = Number(/pid (\d+)/.exec(launched.text)![1]);

      await call('qt_type', { locator: "locator('#qmlWindow >> #usernameField')", text: 'admin' });
      await call('qt_type', { locator: "locator('#qmlWindow >> #passwordField')", text: 'secret', submit: true });
      const checked = await call('qt_expect', { locator: "locator('#qmlWindow').locator('#statusLabel')", assertion: 'toHaveText', expected: 'Welcome, admin!' });
      expect(checked.isError, checked.text).toBe(false);
      const loggedIn = await call('qt_expect', { locator: '#qmlWindow', assertion: 'toHaveProperty', name: 'loginAttempts', expected: 1 });
      expect(loggedIn.text).toContain("await expect(app.locator('#qmlWindow')).toHaveProperty('loginAttempts', 1);");

      await call('qt_close');
      await expect.poll(() => processExists(pid)).toBe(false);
      await client.close();
    } finally {
      await mcp.close();
    }
  });
});

test.describe('connected', () => {
  // only one window, so that nothing else is at the coordinates clicked below
  test.use({ qtApp: { executable: sampleApp, args: ['--widgets-only'] } });

  test('connects to a running application: signals, coordinates, tracing and video', async ({ app }, testInfo) => {
    const context = new McpContext({ outputDir: testInfo.outputPath('mcp'), snapshotAfterAction: false, timeout: 2_000 });
    const server = createMcpServer(context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(clientTransport);
    const call = tools(client);
    try {
      expect((await call('qt_connect', { target: app.connection.url })).text).toContain(`connected to ${app.connection.url}`);
      expect((await call('qt_start_tracing', { title: 'mcp' })).isError).toBe(false);
      expect((await call('qt_start_video', { path: 'session.mp4', fps: 10 })).isError).toBe(false);

      const spy = await call('qt_spy_signal', { locator: '#widgetsWindow', signal: 'loggedIn' });
      const spyId = /Spy (s\d+)/.exec(spy.text)![1];
      await call('qt_type', { locator: '#widgetsWindow >> #username', text: 'admin' });
      await call('qt_type', { locator: '#widgetsWindow >> #password', text: 'secret' });
      // click by screen coordinates, e.g. for custom-painted content
      const info = await call('qt_inspect', { locator: '#widgetsWindow >> #loginButton', properties: false });
      const g = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(info.text)![1]).geometry;
      const xy = await call('qt_mouse_click_xy', { x: g.x + g.width / 2, y: g.y + g.height / 2 });
      expect(xy.text).toContain('await app.mouse.click(');
      const emissions = await call('qt_signal_emissions', { spy: spyId, count: 1 });
      expect(emissions.isError, emissions.text).toBe(false);
      expect(emissions.text).toContain('[["admin"]]');
      await expect(app.locator('#widgetsWindow >> #statusLabel')).toHaveText('Welcome, admin!');

      const evaluated = await call('qt_evaluate', { locator: '#widgetsWindow >> #statusLabel', function: '(label) => label.text.length' });
      expect(evaluated.text).toBe(`Result: ${'Welcome, admin!'.length}`);
      expect((await call('qt_highlight', { locator: '#widgetsWindow >> #loginButton' })).isError).toBe(false);
      expect((await call('qt_highlight')).text).toContain('removed');

      const video = await call('qt_stop_video');
      expect(existsSync(/saved to (\S+)/.exec(video.text)![1])).toBe(true);
      const trace = await call('qt_stop_tracing', { path: 'trace.zip' });
      expect(existsSync(path.join(testInfo.outputPath('mcp'), 'trace.zip'))).toBe(true);
      expect(trace.text).toContain('npx playwright show-trace');

      // a slot that runs a modal dialog's exec() does not block the agent
      await call('qt_set_property', { locator: '#widgetsWindow >> #itemList', name: 'currentRow', value: 1 });
      const invoked = await call('qt_invoke_method', { locator: '#widgetsWindow >> #removeButton', method: 'click' });
      expect(invoked.isError).toBe(true);
      expect(invoked.text).toContain('click() has not returned after 2000 ms. If it opened a modal dialog');
      const dialog = await call('qt_snapshot', { locator: '#confirmDialog' });
      expect(dialog.text).toContain("Remove 'Banana'?");
      expect((await call('qt_click', { locator: "locator('#confirmDialog').getByText('Cancel')" })).isError).toBe(false);
      await expect(app.locator('#confirmDialog')).toBeHidden();

      // closing only disconnects from an application that was not launched by the server
      await call('qt_close');
      expect(app.isRunning()).toBe(true);
      await expect(app.locator('#widgetsWindow >> #statusLabel')).toHaveText('Welcome, admin!');
    } finally {
      await client.close();
      await context.close();
    }
  });
});
