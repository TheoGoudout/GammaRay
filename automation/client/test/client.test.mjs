// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

// Unit tests for the client parts that don't need a Qt application.
// Run with: npm test (after npm run build)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const { Connection, QtError, TimeoutError, quote } = require('../dist/index.js');
const { textSelector } = require('../dist/locator.js');
const { poll } = require('../dist/wait.js');

test('text selectors', () => {
  assert.equal(textSelector('Save'), 'text="Save"');
  assert.equal(textSelector('Save', false), 'text=Save');
  assert.equal(textSelector('He said "hi"'), 'text="He said \\"hi\\""');
  assert.equal(textSelector(/sa.e/i), 'text=/sa.e/i');
  assert.equal(textSelector(/a\/b/), 'text=/a\\/b/');
  assert.equal(quote('x'), '"x"');
});

test('poll retries until done and reports the call log on timeout', async () => {
  let n = 0;
  assert.equal(await poll('op', 1000, async () => ({ done: ++n === 3, value: n })), 3);

  await assert.rejects(
    poll('locator.click', 100, async () => ({ done: false, log: 'element is not enabled' })),
    (e) => e instanceof TimeoutError && /Timeout 100ms exceeded/.test(e.message) && /element is not enabled/.test(e.message),
  );
});

test('JSON-RPC connection: results, errors, notifications, close', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const req = JSON.parse(data.toString());
      if (req.method === 'echo') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: req.params }));
      else ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: 1001, message: 'element 7 no longer exists' } }));
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'objectsCreated', params: { elements: [] } }));
    });
  });
  const url = `ws://127.0.0.1:${server.address().port}`;
  const conn = await Connection.connect(url);
  const notified = new Promise((r) => conn.once('objectsCreated', r));

  assert.deepEqual(await conn.call('echo', { a: 1 }), { a: 1 });
  await assert.rejects(conn.call('click', { handle: 7 }), (e) => e instanceof QtError && e.code === 1001 && e.method === 'click');
  assert.deepEqual(await notified, { elements: [] });

  // pending calls fail when the application goes away
  for (const client of server.clients) client.terminate();
  await new Promise((r) => conn.once('close', r));
  await assert.rejects(conn.call('echo'), /closed/);
  server.close();
});
