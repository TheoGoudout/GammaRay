// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

export { QtApp, type AppInfo } from './app';
export { CodeRecorder, renderAction, type RecordedAction, type RecordedLocator } from './codegen';
export { Connection } from './connection';
export { ConnectionClosedError, ErrorCode, QtError, StrictModeViolationError, TimeoutError } from './errors';
export { renderAriaSnapshot, matchesAriaTemplate, parseAriaTemplate, type AriaNode } from './aria';
export { Dialog, FileChooser } from './dialogs';
export {
  AppAssertions,
  expect,
  expectDefaults,
  ExpectError,
  LocatorAssertions,
  setScreenshotComparator,
  SignalSpyAssertions,
  type ScreenshotAssertionOptions,
} from './expect';
export { Keyboard, Mouse, Touchscreen } from './input';
export { addStepListener, removeStepListener, setStepRunner, type StepListener } from './instrumentation';
export { attach, DEFAULT_DISABLED_PLUGINS, launch, type AttachOptions, type LaunchOptions } from './launcher';
export { Locator, type FilterOptions } from './locator';
export { quote, roleSelector, textSelector, type AriaRole, type ByRoleOptions } from './selectors';
export { Tracing, type TracingStartOptions, type TracingStopOptions } from './tracing';
export { SignalSpy } from './signalspy';
export { Video, type RecordVideoOptions, type VideoOptions } from './video';
export * from './types';
