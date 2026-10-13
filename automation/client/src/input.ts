// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

// Coordinate-level input, like Playwright's page.mouse / page.keyboard / page.touchscreen.
// Coordinates are global (screen) coordinates, the same space as Locator.boundingBox().

import type { QtApp } from './app';
import { step } from './instrumentation';
import type { MouseButton } from './types';
import { sleep } from './wait';

export class Mouse {
  constructor(private readonly app: QtApp) {}

  /** Moves the pointer to (x, y), in @p steps intermediate moves (default 1). */
  async move(x: number, y: number, options: { steps?: number } = {}): Promise<void> {
    await step(`mouse.move(${x}, ${y})`, () => this.app.connection.call('mouseMove', { x, y, steps: options.steps ?? 1 }));
  }

  async down(options: { button?: MouseButton; clickCount?: number } = {}): Promise<void> {
    await step('mouse.down', () => this.app.connection.call('mouseDown', { button: options.button, clickCount: options.clickCount }));
  }

  async up(options: { button?: MouseButton; clickCount?: number } = {}): Promise<void> {
    await step('mouse.up', () => this.app.connection.call('mouseUp', { button: options.button, clickCount: options.clickCount }));
  }

  async click(x: number, y: number, options: { button?: MouseButton; clickCount?: number; delay?: number } = {}): Promise<void> {
    await step(`mouse.click(${x}, ${y})`, async () => {
      await this.app.connection.call('mouseMove', { x, y, steps: 1 });
      const clickCount = options.clickCount ?? 1;
      for (let i = 1; i <= clickCount; ++i) {
        await this.app.connection.call('mouseDown', { button: options.button, clickCount: i });
        if (options.delay) await sleep(options.delay);
        await this.app.connection.call('mouseUp', { button: options.button, clickCount: i === clickCount ? 1 : 2 });
      }
    });
  }

  async dblclick(x: number, y: number, options: { button?: MouseButton; delay?: number } = {}): Promise<void> {
    await this.click(x, y, { ...options, clickCount: 2 });
  }

  /** Wheel at the pointer position, in Qt angle units (120 = one notch); positive deltaY scrolls down. */
  async wheel(deltaX: number, deltaY: number): Promise<void> {
    await step('mouse.wheel', () => this.app.connection.call('mouseWheel', { deltaX, deltaY }));
  }
}

export class Keyboard {
  constructor(private readonly app: QtApp) {}

  /** Presses a key without releasing it; held modifiers apply to later key and mouse input. */
  async down(key: string): Promise<void> {
    await step(`keyboard.down(${JSON.stringify(key)})`, () => this.app.connection.call('keyDown', { key }));
  }

  async up(key: string): Promise<void> {
    await step(`keyboard.up(${JSON.stringify(key)})`, () => this.app.connection.call('keyUp', { key }));
  }

  async press(key: string, options: { delay?: number } = {}): Promise<void> {
    await step(`keyboard.press(${JSON.stringify(key)})`, async () => {
      if (!options.delay) return this.app.connection.call('press', { key });
      await this.app.connection.call('keyDown', { key });
      await sleep(options.delay);
      await this.app.connection.call('keyUp', { key });
    });
  }

  /** Types text into the focused element, key by key. */
  async type(text: string, options: { delay?: number } = {}): Promise<void> {
    await step('keyboard.type', async () => {
      if (!options.delay) return this.app.connection.call('type', { text });
      for (const ch of text) {
        await this.app.connection.call('type', { text: ch });
        await sleep(options.delay);
      }
    });
  }

  /** Inserts text into the focused element without key events (input method commit). */
  async insertText(text: string): Promise<void> {
    await step('keyboard.insertText', () => this.app.connection.call('insertText', { text }));
  }
}

export class Touchscreen {
  constructor(private readonly app: QtApp) {}

  async tap(x: number, y: number): Promise<void> {
    await step(`touchscreen.tap(${x}, ${y})`, () => this.app.connection.call('tap', { x, y }));
  }
}
