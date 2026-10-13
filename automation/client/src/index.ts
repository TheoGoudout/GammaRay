// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

export { QtApp, type AppInfo } from './app';
export { Connection } from './connection';
export { ConnectionClosedError, ErrorCode, QtError, StrictModeViolationError, TimeoutError } from './errors';
export { expect, expectDefaults, ExpectError, LocatorAssertions, SignalSpyAssertions } from './expect';
export { setStepRunner } from './instrumentation';
export { attach, DEFAULT_DISABLED_PLUGINS, launch, type AttachOptions, type LaunchOptions } from './launcher';
export { Locator, quote } from './locator';
export { SignalSpy } from './signalspy';
export * from './types';
