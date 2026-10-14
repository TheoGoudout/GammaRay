// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ConnectionClosedError, QtError, TimeoutError } from './errors';

interface Pending {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

/**
 * JSON-RPC 2.0 client for the GammaRay automation server.
 *
 * Requests are sent in order and executed by the application in that order, which the
 * higher-level API relies on (e.g. a waitForSignal request issued before a click).
 * Server notifications are re-emitted as events named after the notification method.
 */
export class Connection extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closedError: Error | undefined;

  private constructor(private readonly ws: WebSocket, readonly url: string) {
    super();
    ws.on('message', (data, isBinary) => {
      // binary messages carry recorded video frames
      if (isBinary) this.emit('binary', data as Buffer);
      else this.onMessage(data.toString());
    });
    ws.on('close', () => this.onClose(new ConnectionClosedError(`connection to ${url} closed`)));
    ws.on('error', (err) => this.onClose(new ConnectionClosedError(`connection to ${url} failed: ${err.message}`)));
  }

  /** Wraps an already open WebSocket (e.g. relayed by a remote qt-playwright server). */
  static fromSocket(ws: WebSocket, url: string): Connection {
    return new Connection(ws, url);
  }

  static connect(url: string, timeoutMs = 10_000): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new TimeoutError(`timed out connecting to ${url}`));
      }, timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new Connection(ws, url));
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(new ConnectionClosedError(`could not connect to ${url}: ${err.message}`));
      });
    });
  }

  get isClosed(): boolean {
    return this.closedError !== undefined;
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new ConnectionClosedError(`failed to send ${method}: ${err.message}`));
        }
      });
    });
  }

  close(): void {
    if (!this.closedError) this.ws.close();
    this.onClose(new ConnectionClosedError('connection closed by client'));
  }

  private onMessage(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new QtError(msg.error.message, msg.error.code, p.method, msg.error.data));
      else p.resolve(msg.result);
    } else if (typeof msg.method === 'string') {
      this.emit(msg.method, msg.params);
    }
  }

  private onClose(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.emit('close', error);
  }
}
