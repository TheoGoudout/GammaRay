// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Brief element description as returned by queries. */
export interface ElementRef {
  /** Stable id of the object inside the application (valid while the object lives). */
  handle: number;
  /** Most specific type name (QML type when available, else C++ class). */
  type: string;
  objectName?: string;
  /** QML id, if the object was declared in QML with an id. */
  id?: string;
}

/** Full element description (`describe`). */
export interface ElementInfo extends ElementRef {
  className: string;
  typeNames: string[];
  text?: string;
  visible: boolean;
  enabled: boolean;
  /** Bounding box in global (screen) coordinates. */
  geometry?: Rect;
  /** ARIA-style role from Qt's accessibility interface (e.g. "button", "textbox"). */
  role?: string;
  accessibleName?: string;
  accessibleDescription?: string;
  /** -1: not an input, 0: read-only or disabled, 1: editable */
  editable?: number;
}

export type MouseButton = 'left' | 'right' | 'middle';
export type Modifier = 'Shift' | 'Control' | 'Alt' | 'Meta' | 'ControlOrMeta';

export interface TimeoutOptions {
  /** Maximum time in milliseconds; defaults to the app's default timeout. */
  timeout?: number;
}

export interface ActionOptions extends TimeoutOptions {
  /** Skip the actionability checks (visible, enabled, stable, receives events). */
  force?: boolean;
  /** Only perform the actionability checks, not the action itself. */
  trial?: boolean;
}

export interface PointerOptions extends ActionOptions {
  /** Point relative to the element's top-left corner; defaults to its center. */
  position?: Point;
  modifiers?: Modifier[];
}

export interface ClickOptions extends PointerOptions {
  button?: MouseButton;
  clickCount?: number;
  /** Milliseconds between mouse press and release. */
  delay?: number;
}

export interface TypeOptions extends ActionOptions {
  /** Milliseconds between key presses. */
  delay?: number;
}

/** An option for selectOption(): matched by label or value when given as a string. */
export type SelectOption = string | { label?: string; value?: string; index?: number };

export interface ScrollOptions extends PointerOptions {
  /** Horizontal wheel delta in Qt angle units (120 = one notch); positive scrolls right. */
  deltaX?: number;
  /** Vertical wheel delta in Qt angle units (120 = one notch); positive scrolls down. */
  deltaY?: number;
}

export interface DragOptions extends ActionOptions {
  /** Grab point relative to the source element. */
  sourcePosition?: Point;
  /** Drop point relative to the target element. */
  targetPosition?: Point;
  /** Number of intermediate mouse moves (default 10). */
  steps?: number;
  button?: MouseButton;
  modifiers?: Modifier[];
}

export interface ScreenshotOptions extends TimeoutOptions {
  /** Elements to paint over with `maskColor` (default #ff00ff). */
  mask?: import('./locator').Locator[];
  maskColor?: string;
  /** 'hide' keeps the text cursor steady so screenshots are reproducible. */
  caret?: 'hide' | 'initial';
  /** Write the PNG to this file as well. */
  path?: string;
  /** Capture the element's whole window instead of just the element. */
  window?: boolean;
}

export type WaitForState = 'attached' | 'detached' | 'visible' | 'hidden';
