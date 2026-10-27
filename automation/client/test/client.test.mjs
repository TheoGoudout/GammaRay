// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

// Unit tests for the client parts that don't need a Qt application.
// Run with: npm test (after npm run build)

import assert from 'node:assert/strict';
import {existsSync,
        mkdirSync,
        mkdtempSync,
        readFileSync,
        rmSync,
        writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,
        join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';

const require = createRequire(import.meta.url);
const {Connection, QtError, TimeoutError, quote} = require('../dist/index.js');
const {textSelector, roleSelector, propertySelector} = require('../dist/selectors.js');
const {poll} = require('../dist/wait.js');

test('text selectors', () => {
    assert.equal(textSelector('Save', true), 'text="Save"');
    assert.equal(textSelector('Save'), 'text="Save"i'); // Playwright default: substring
    assert.equal(roleSelector('button', {name : 'OK'}), 'role=button[name="OK"i]');
    assert.equal(roleSelector('checkbox', {name : /re/, checked : true, includeHidden : true}),
                 'role=checkbox[name=/re/][checked=true][include-hidden=true]');
    assert.equal(propertySelector('placeholderText', 'a.b'), '[placeholderText=/a\\.b/i]');
    assert.equal(textSelector('He said "hi"', true), 'text="He said \\"hi\\""');
    assert.equal(textSelector(/sa.e/i), 'text=/sa.e/i');
    assert.equal(textSelector(/a\/b/), 'text=/a\\/b/');
    assert.equal(quote('x'), '"x"');
});

test('poll retries until done and reports the call log on timeout', async () => {
    let n = 0;
    assert.equal(await poll('op', 1000, async () => ({done : ++n === 3, value : n})), 3);

    await assert.rejects(
        poll('locator.click', 100, async () => ({done : false, log : 'element is not enabled'})),
        (e) => e instanceof TimeoutError && /Timeout 100ms exceeded/.test(e.message) && /element is not enabled/.test(e.message),
    );
});

test('JSON-RPC connection: results, errors, notifications, close', async () => {
    const server = new WebSocketServer({port : 0, host : '127.0.0.1'});
    await new Promise((r) => server.once('listening', r));
    server.on('connection', (ws) => {
        ws.on('message', (data) => {
            const req = JSON.parse(data.toString());
            if (req.method === 'echo')
                ws.send(JSON.stringify({jsonrpc : '2.0', id : req.id, result : req.params}));
            else
                ws.send(JSON.stringify({jsonrpc : '2.0', id : req.id, error : {code : 1001, message : 'element 7 no longer exists'}}));
            ws.send(JSON.stringify({jsonrpc : '2.0', method : 'objectsCreated', params : {elements : []}}));
        });
    });
    const url = `ws://127.0.0.1:${server.address().port}`;
    const conn = await Connection.connect(url);
    const notified = new Promise((r) => conn.once('objectsCreated', r));

    assert.deepEqual(await conn.call('echo', {a : 1}), {a : 1});
    await assert.rejects(conn.call('click', {handle : 7}), (e) => e instanceof QtError && e.code === 1001 && e.method === 'click');
    assert.deepEqual(await notified, {elements : []});

    // pending calls fail when the application goes away
    for (const client of server.clients)
        client.terminate();
    await new Promise((r) => conn.once('close', r));
    await assert.rejects(conn.call('echo'), /closed/);
    server.close();
});

test('aria snapshots: rendering and partial template matching', () => {
    const {renderAriaSnapshot, matchesAriaTemplate} = require('../dist/aria.js');
    const tree = [ {
        role : 'group',
        name : 'Login',
        children : [
            {role : 'textbox', name : 'User', value : 'admin'},
            {role : 'checkbox', name : 'Remember me', checked : true},
            {role : 'button', name : 'Login', disabled : true},
            {role : 'text', name : 'Please log in'},
        ],
    } ];
    assert.equal(renderAriaSnapshot(tree), [
        '- group "Login":',
        '  - textbox "User": admin',
        '  - checkbox "Remember me" [checked]',
        '  - button "Login" [disabled]',
        '  - text: Please log in',
    ].join('\n'));
    // subset, in order, with regexes and attributes
    assert.ok(matchesAriaTemplate(`
    - group "Login":
      - textbox /Us/: admin
      - button "Login" [disabled]
  `,
                                  tree));
    assert.ok(matchesAriaTemplate('- button "Login"', tree)); // found anywhere
    assert.ok(!matchesAriaTemplate('- button "Login" [disabled=false]', tree));
    assert.ok(!matchesAriaTemplate(`
    - group "Login":
      - button "Login"
      - textbox "User"
  `,
                                   tree)); // wrong order
    assert.ok(!matchesAriaTemplate('- checkbox "Remember me" [checked=false]', tree));
});

test('aria snapshots with refs', () => {
    const {renderAriaSnapshot, handleForRef} = require('../dist/aria.js');
    const tree = [ {
        role : 'window',
        name : 'Main',
        handle : 3,
        children : [ {role : 'button', name : 'OK', handle : 12, disabled : true}, {role : 'text', name : 'Hi', handle : 13} ],
    } ];
    assert.equal(renderAriaSnapshot(tree, {refs : true}), [
        '- window "Main" [ref=e3]:',
        '  - button "OK" [disabled] [ref=e12]',
        '  - text "Hi" [ref=e13]',
    ].join('\n'));
    // without refs, handles are ignored
    assert.equal(renderAriaSnapshot(tree), '- window "Main":\n  - button "OK" [disabled]\n  - text: Hi');
    // long lists are shortened
    const list = [ {role : 'list', handle : 5, children : [ 1, 2, 3, 4 ].map((i) => ({role : 'listitem', name : `Row ${i}`, handle : 10 + i}))} ];
    assert.equal(renderAriaSnapshot(list, {refs : true, maxChildren : 2, omitted : (p, n) => `${n} more in e${p.handle}`}),
                 '- list [ref=e5]:\n  - listitem "Row 1" [ref=e11]\n  - listitem "Row 2" [ref=e12]\n  # 2 more in e5');
    assert.equal(renderAriaSnapshot(list, {maxChildren : 3}).split('\n').pop(), '  # ... and 1 more');
    assert.equal(handleForRef('e12'), 12);
    assert.equal(handleForRef('[ref=e12]'), 12);
    assert.equal(handleForRef('12'), 12);
    assert.equal(handleForRef('button'), undefined);
});

test('locator expressions are parsed without evaluating code', () => {
    const {QtApp, parseLocator, isLocatorExpression, LocatorExpressionError} = require('../dist/index.js');
    const app = new QtApp({}, {appName : 'test'});
    const parse = (text) => parseLocator(app, text);

    assert.equal(parse("getByRole('button', { name: 'Login' })").selector, 'role=button[name="Login"i]');
    assert.equal(parse("app.getByRole('button', { name: 'Login', exact: true })").expression,
                 "getByRole('button', { name: 'Login', exact: true })");
    assert.equal(parse('getByText(/sa.e/i).first()').selector, 'text=/sa.e/i >> nth=0');
    assert.equal(parse(`locator("#box").getByLabel('User:').nth(-1)`).selector, '#box >> label="User:"i >> nth=-1');
    assert.equal(parse("getByRole('listitem').filter({ has: getByText('Done'), visible: true })").selector,
                 'role=listitem >> has="text=\\"Done\\"i" >> visible=true');
    assert.equal(parse("getByRole('checkbox', { checked: false, 'level': 2 })").selector, 'role=checkbox[checked=false][level=2]');
    assert.equal(parse("getByText('it\\'s \\u00e9')").selector, `text="it's é"i`);
    assert.equal(parse('getByRole(`row`).or(getByRole("cell"))').selector, 'role=row >> or="role=cell"');
    // selectors
    assert.equal(parse('#okButton').selector, '#okButton');
    assert.equal(parse('QPushButton[text="OK (1)"]').selector, 'QPushButton[text="OK (1)"]');
    assert.ok(!isLocatorExpression('text="Save (draft)"'));
    // only locator-building methods and literals
    for (const bad of ["getByRole('button').click()", "constructor('x')", "getByRole(process.exit(1))", "getByText('a' + 'b')",
                       'getByText(`${x}`)', "getByRole('button'", "getByRole('button')) ; x()", "first()", "getByRole('x').describe()"])
        assert.throws(() => parse(bad), LocatorExpressionError, bad);
});

/**
 * A minimal fake automation server: one window with a button that changes the label when clicked.
 */
async function fakeApp() {
    let clicked = false;
    const tree = () => [{
        role : 'window',
        name : 'Fake',
        handle : 1,
        children : [ {role : 'button', name : 'Go', handle : 2}, {role : 'text', name : clicked ? 'Done' : 'Idle', handle : 3} ],
    }];
    const geometry = {x : 10, y : 10, width : 80, height : 30};
    const handlers = {
        hello : () => ({protocolVersion : 1, pid : 4242, appName : 'fake', qtVersion : '6.8.3', platform : 'offscreen'}),
        ariaSnapshot : (p) => ({nodes : p.refs ? tree() : JSON.parse(JSON.stringify(tree(), (k, v) => (k === 'handle' ? undefined : v)))}),
        sync : () => ({}),
        windows : () => ({elements : [ {handle : 1, type : 'QWidget', text : 'Fake'} ]}),
        locatorFor : (p) => {
            if (p.handle !== 2)
                throw {code : 1001, message : `element ${p.handle} no longer exists`};
            return {code : "app.getByRole('button', { name: 'Go' })", selector : 'role=button[name="Go"]'};
        },
        query : (p) => ({elements : p.selector === 'handle=2' || p.selector.startsWith('role=button') ? [ {handle : 2, type : 'QPushButton'} ] : []}),
        scrollIntoView : () => ({scrolled : false}),
        actionability : () => ({attached : true, visible : true, enabled : true, editable : -1, hasGeometry : true, geometry}),
        click : () => {
            clicked = true;
            return {};
        },
    };
    const server = new WebSocketServer({port : 0, host : '127.0.0.1'});
    await new Promise((r) => server.once('listening', r));
    server.on('connection', (ws) => ws.on('message', (data) => {
        const req = JSON.parse(data.toString());
        try {
            const handler = handlers[req.method];
            if (!handler)
                throw {code : -32601, message : `unknown method ${req.method}`};
            ws.send(JSON.stringify({jsonrpc : '2.0', id : req.id, result : handler(req.params ?? {})}));
        } catch (e) {
            ws.send(JSON.stringify({jsonrpc : '2.0', id : req.id, error : e}));
        }
    }));
    return {server, target : `127.0.0.1:${server.address().port}`};
}

async function mcpClient(options) {
    const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
    const {InMemoryTransport} = require('@modelcontextprotocol/sdk/inMemory.js');
    const {createMcpServer, McpContext} = require('../dist/mcp.js');
    const context = new McpContext(options);
    const server = createMcpServer(context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({name : 'test', version : '1.0.0'});
    await client.connect(clientTransport);
    const call = async (name, args = {}) => {
        const r = await client.callTool({name, arguments : args});
        return {...r, text : r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')};
    };
    return {client, context, call};
}

test('MCP server: tools, and errors without an application', async () => {
    const {client, context, call} = await mcpClient({apps : [ '/opt/app/bin/app' ]});
    const {tools} = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ['qt_launch', 'qt_connect', 'qt_snapshot', 'qt_click', 'qt_type', 'qt_expect', 'qt_screenshot', 'qt_generate_test'])
        assert.ok(names.includes(name), name);
    assert.ok(tools.find((t) => t.name === 'qt_snapshot').annotations.readOnlyHint);

    const refused = await call('qt_launch', {executable : '/usr/bin/xterm'});
    assert.ok(refused.isError);
    assert.match(refused.text, /only launches \/opt\/app\/bin\/app/);

    const {call : call2, context : context2} = await mcpClient({});
    const none = await call2('qt_snapshot');
    assert.ok(none.isError);
    assert.match(none.text, /No application is connected.*qt_launch/);
    assert.match((await call2('qt_click', {locator : "getByRole('button').click()"})).text, /No application/);
    await client.close();
    await context.close();
    await context2.close();
});

test('MCP server: snapshot refs, actions and generated code against an automation server', async () => {
    const {server, target} = await fakeApp();
    const outputDir = mkdtempSync(join(tmpdir(), 'qtpw-mcp-test-'));
    const {call, context} = await mcpClient({timeout : 2000, outputDir});
    try {
        assert.match((await call('qt_connect', {target})).text, /fake \(pid 4242, Qt 6\.8\.3.*connected to/s);
        const snapshot = await call('qt_snapshot');
        assert.match(snapshot.text, /- button "Go" \[ref=e2\]/);
        assert.match(snapshot.text, /- text "Idle" \[ref=e3\]/);

        const clicked = await call('qt_click', {element : 'Go button', ref : 'e2'});
        assert.ok(!clicked.isError, clicked.text);
        assert.match(clicked.text, /await app\.getByRole\('button', \{ name: 'Go' \}\)\.click\(\);/);
        assert.match(clicked.text, /- text "Done" \[ref=e3\]/); // fresh snapshot after the action

        // nothing changed: the snapshot is not repeated
        assert.match((await call('qt_click', {ref : 'e2'})).text, /### Snapshot\nunchanged/);
        // a ref whose element is gone, and a ref that is not one
        assert.match((await call('qt_click', {ref : 'e99'})).text, /no longer exists.*qt_snapshot/s);
        assert.match((await call('qt_click', {ref : 'Go'})).text, /is not a ref/);
        // locators instead of refs
        const byLocator = await call('qt_find', {locator : "getByRole('button', { name: 'Go' })"});
        assert.match(byLocator.text, /matches 1 element/);

        const generated = await call('qt_generate_test', {name : 'go', path : 'go.spec.ts'});
        assert.match(generated.text, /test\('go', async \(\{ app \}\) => \{\n(  await app\.getByRole\('button', \{ name: 'Go' \}\)\.click\(\);\n){2}\}\);/);
        assert.match(generated.text, /Saved to .*go\.spec\.ts/);
        assert.match(generated.text, /use: \{ qtApp: \{ connect: '127\.0\.0\.1:\d+' \} \}/);
        // files stay in the output directory
        assert.match((await call('qt_generate_test', {path : '../../etc/x.spec.ts'})).text, /below the output directory/);
    } finally {
        await context.close();
        server.close();
        rmSync(outputDir, {recursive : true, force : true});
    }
});

test('MCP helpers: code literals and new output', () => {
    const {codeLiteral, newOutput} = require('../dist/mcp.js');
    assert.equal(codeLiteral({button : 'right', modifiers : [ 'Shift' ], 'a-b' : /x/i}), "{ button: 'right', modifiers: ['Shift'], 'a-b': /x/i }");
    assert.equal(codeLiteral("it's\n"), "'it\\'s\\n'");
    assert.equal(newOutput('', 'a\n'), 'a\n');
    assert.equal(newOutput('a\n', 'a\nb\n'), 'b\n');
    // the bounded output buffer dropped its beginning
    assert.equal(newOutput('a'.repeat(300) + 'TAIL', 'a'.repeat(250) + 'TAIL' +
                                                         'new'),
                 'new');
});

test('mcp install: options, agents and their configuration files', () => {
    const {parseMcpArgs, parseInstallArgs, install, updatedConfig, UsageError} = require('../dist/mcpinstall.js');
    // paths become absolute (except executables on a remote server)
    assert.deepEqual(parseMcpArgs([ '--app', 'build/app', '--headless', '--output-dir', 'out' ], '/work').argv,
                     [ '--headless', '--output-dir', '/work/out', '--app', '/work/build/app' ]);
    assert.deepEqual(parseMcpArgs([ '--remote', 'ws://dev:9900', '--app', 'bin/app' ], '/work').argv, [ '--remote', 'ws://dev:9900', '--app', 'bin/app' ]);
    assert.throws(() => parseMcpArgs([ '--ap', 'x' ]), UsageError);
    assert.throws(() => parseMcpArgs([ '--timeout', 'soon' ]), UsageError);
    const parsed = parseInstallArgs([ 'claude', '--scope', 'user', '--app', '/a', '--name', 'myapp', '--print' ]);
    assert.equal(parsed.agent, 'claude');
    assert.equal(parsed.scope, 'user');
    assert.equal(parsed.name, 'myapp');
    assert.deepEqual(parsed.serverArgv, [ '--app', '/a' ]);

    const dir = mkdtempSync(join(tmpdir(), 'qtpw-install-test-'));
    const base = {node : '/usr/bin/node', cli : '/qtpw/cli.js', serverArgs : [ '--app', '/opt/app' ]};
    const environment = {dir : join(dir, 'proj'), home : join(dir, 'home'), platform : 'linux', env : {PATH : '', QT_PLAYWRIGHT_GAMMARAY : '/gr/bin/gammaray'}};
    const expectedArgs = [ '/qtpw/cli.js', 'mcp', '--app', '/opt/app', '--gammaray', '/gr/bin/gammaray' ];
    try {
        const files = {
            'claude-code' : join(dir, 'proj', '.mcp.json'),
            'claude-desktop' : join(dir, 'home', '.config', 'Claude', 'claude_desktop_config.json'),
            cursor : join(dir, 'proj', '.cursor', 'mcp.json'),
            vscode : join(dir, 'proj', '.vscode', 'mcp.json'),
            windsurf : join(dir, 'home', '.codeium', 'windsurf', 'mcp_config.json'),
            gemini : join(dir, 'proj', '.gemini', 'settings.json'),
        };
        for (const [agent, file] of Object.entries(files)) {
            const r = install({...base, agent, environment});
            assert.equal(r.file, file, agent);
            const json = JSON.parse(readFileSync(file, 'utf8'));
            const entry = agent === 'vscode' ? json.servers.qt : json.mcpServers.qt;
            assert.deepEqual(entry, {...(agent === 'vscode' ? {type : 'stdio'} : {}), command : '/usr/bin/node', args : expectedArgs}, agent);
        }
        // other servers and settings are kept; the entry is replaced
        writeFileSync(files.cursor, JSON.stringify({mcpServers : {other : {command : 'x'}, qt : {command : 'old'}}, theme : 'dark'}));
        install({...base, agent : 'cursor', environment});
        const cursor = JSON.parse(readFileSync(files.cursor, 'utf8'));
        assert.deepEqual(Object.keys(cursor.mcpServers), [ 'other', 'qt' ]);
        assert.equal(cursor.theme, 'dark');
        assert.equal(cursor.mcpServers.qt.command, '/usr/bin/node');
        // user scope, --print does not write
        const printed = install({...base, agent : 'cursor', scope : 'user', print : true, environment});
        assert.equal(printed.file, join(dir, 'home', '.cursor', 'mcp.json'));
        assert.ok(!existsSync(printed.file));
        assert.throws(() => install({...base, agent : 'windsurf', scope : 'project', environment}), /supports --scope user/);
        assert.throws(() => install({...base, agent : 'emacs', environment}), /unknown agent/);
        writeFileSync(files.gemini, '{ broken');
        assert.throws(() => install({...base, agent : 'gemini', environment}), /cannot parse the existing file/);

        // Codex: TOML table appended, then replaced in place (sub-tables included)
        const codex = join(dir, 'home', '.codex', 'config.toml');
        mkdirSync(dirname(codex), {recursive : true});
        writeFileSync(codex, 'model = "o4"\n\n[mcp_servers.qt]\ncommand = "old"\n\n[mcp_servers.qt.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "y"\n');
        install({...base, agent : 'codex', environment});
        assert.equal(readFileSync(codex, 'utf8'), [
            'model = "o4"', '', '[mcp_servers.qt]', 'command = "/usr/bin/node"',
            `args = [${expectedArgs.map((a) => JSON.stringify(a)).join(', ')}]`, '', '[mcp_servers.other]', 'command = "y"', ''
        ].join('\n'));
        assert.equal(updatedConfig('codex', '', 'qt', {command : 'n', args : []}), '[mcp_servers.qt]\ncommand = "n"\nargs = []\n');

        // Claude Code user scope goes through `claude mcp add`
        const calls = [];
        const r = install({...base, agent : 'claude-code', scope : 'user', environment, run : (c, a) => (calls.push([ c, ...a ]), {status : 0})});
        assert.deepEqual(calls[1], [ 'claude', 'mcp', 'add', '--scope', 'user', 'qt', '--', '/usr/bin/node', ...expectedArgs ]);
        assert.match(r.message, /Added "qt" to Claude Code \(user scope\)/);
        assert.match(install({...base, agent : 'claude', scope : 'local', print : true, environment}).content,
                     /^claude mcp add --scope local qt -- \/usr\/bin\/node \/qtpw\/cli\.js mcp --app \/opt\/app/);
        // without gammaray, a warning
        assert.match(install({...base, agent : 'cursor', environment : {...environment, env : {PATH : ''}}}).message, /gammaray was not found/);
    } finally {
        rmSync(dir, {recursive : true, force : true});
    }
});

test('mcp install: command line', () => {
    const {spawnSync} = require('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'qtpw-install-cli-'));
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const env = {...process.env, QT_PLAYWRIGHT_GAMMARAY : '/gr/gammaray'};
    try {
        const r = spawnSync(process.execPath, [ cli, 'mcp', 'install', 'cursor', '--dir', dir, '--app', 'app', '--headless' ], {encoding : 'utf8', env, cwd : dir});
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stderr, /Created .*\.cursor\/mcp\.json with the MCP server "qt"/);
        const entry = JSON.parse(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8')).mcpServers.qt;
        assert.deepEqual(entry.args, [ cli, 'mcp', '--headless', '--app', join(dir, 'app'), '--gammaray', '/gr/gammaray' ]);
        const bad = spawnSync(process.execPath, [ cli, 'mcp', 'install', 'cursor', '--bogus' ], {encoding : 'utf8', env});
        assert.equal(bad.status, 2);
        assert.match(bad.stderr, /unknown option --bogus[\s\S]*claude-code/);
    } finally {
        rmSync(dir, {recursive : true, force : true});
    }
});
