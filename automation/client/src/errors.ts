// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

/** Error codes reported by the probe-side automation server. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  StaleHandle: 1001,
  NotFound: 1002,
  Timeout: 1003,
  NotActionable: 1004,
  Failed: 1005,
  InvalidSelector: 1006,
} as const;

/** An error returned by the automation server inside the application. */
export class QtError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly method: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'QtError';
  }
}

/** An operation did not complete within its timeout. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** A locator used for an action matched more than one element. */
export class StrictModeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictModeViolationError';
  }
}

/** The connection to the application was lost (e.g. it crashed or exited). */
export class ConnectionClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionClosedError';
  }
}
