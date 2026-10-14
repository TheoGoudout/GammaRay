// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import type { QtApp } from './app';

export interface RecordedLocator {
  /** TypeScript expression, e.g. app.getByRole('button', { name: 'Login' }) */
  code: string;
  /** The selector it resolves to. */
  selector: string;
}

export interface RecordedAction {
  action: 'click' | 'dblclick' | 'check' | 'uncheck' | 'fill' | 'press' | 'selectOption' | 'dragTo' | 'dragBy';
  target: RecordedLocator;
  value?: string;
  key?: string;
  to?: RecordedLocator;
  dx?: number;
  dy?: number;
  sourcePosition?: { x: number; y: number };
  modifiers?: string[];
  position?: { x: number; y: number };
}

const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

/** One line of test code for @p a. */
export function renderAction(a: RecordedAction): string {
  const t = a.target.code;
  const pos = a.sourcePosition ? `{ sourcePosition: { x: ${a.sourcePosition.x}, y: ${a.sourcePosition.y} } }` : '';
  switch (a.action) {
    case 'fill':
      return `await ${t}.fill(${str(a.value ?? '')});`;
    case 'press':
      return `await ${t}.press(${str(a.key ?? '')});`;
    case 'selectOption':
      return `await ${t}.selectOption(${str(a.value ?? '')});`;
    case 'dragTo':
      return `await ${t}.dragTo(${a.to!.code}${pos ? `, ${pos}` : ''});`;
    case 'dragBy':
      return `await ${t}.dragBy(${a.dx}, ${a.dy}${pos ? `, ${pos}` : ''});`;
    case 'click': {
      const options = [
        ...(a.modifiers?.length ? [`modifiers: [${a.modifiers.map(str).join(', ')}]`] : []),
        ...(a.position ? [`position: { x: ${a.position.x}, y: ${a.position.y} }`] : []),
      ];
      return `await ${t}.click(${options.length ? `{ ${options.join(', ')} }` : ''});`;
    }
    default:
      return `await ${t}.${a.action}();`;
  }
}

/**
 * Records what is done in the application (by a user or by the API) as test code,
 * like Playwright's codegen. Locators are chosen in Playwright's order of preference:
 * role + name, label, placeholder, id, text, type, made unique within the window if needed.
 */
export class CodeRecorder {
  readonly actions: RecordedAction[] = [];
  private stopped = false;
  private readonly listener = (a: RecordedAction) => this.add(a);

  private constructor(
    private readonly app: QtApp,
    private readonly onChange?: (actions: RecordedAction[]) => void,
  ) {}

  static async start(app: QtApp, onChange?: (actions: RecordedAction[]) => void): Promise<CodeRecorder> {
    const recorder = new CodeRecorder(app, onChange);
    app.connection.on('codegenAction', recorder.listener);
    await app.connection.call('startCodegen');
    return recorder;
  }

  private add(a: RecordedAction): void {
    const last = this.actions[this.actions.length - 1];
    if (last && last.target.selector === a.target.selector) {
      // opening a combo box popup is part of selecting the option
      if (a.action === 'selectOption' && last.action === 'click') this.actions.pop();
      // typing into the same field again: keep the final text only
      else if (a.action === 'fill' && last.action === 'fill') this.actions.pop();
      // a double click starts with a click
      else if (a.action === 'dblclick' && last.action === 'click') this.actions.pop();
    }
    this.actions.push(a);
    this.onChange?.(this.actions);
  }

  /** The recorded steps, one line each. */
  lines(): string[] {
    return this.actions.map(renderAction);
  }

  /** A complete @playwright/test file with the recorded steps. */
  code(options: { testName?: string } = {}): string {
    const body = this.lines()
      .map((l) => `  ${l}`)
      .join('\n');
    return [
      "import { expect, test } from 'qt-playwright/test';",
      '',
      `test(${str(options.testName ?? 'recorded')}, async ({ app }) => {`,
      body,
      '});',
      '',
    ].join('\n');
  }

  /** Stops recording (pending typing is flushed) and returns the test file. */
  async stop(options: { testName?: string } = {}): Promise<string> {
    if (!this.stopped) {
      this.stopped = true;
      await this.app.connection.call('stopCodegen').catch(() => undefined);
      this.app.connection.off('codegenAction', this.listener);
    }
    return this.code(options);
  }
}
