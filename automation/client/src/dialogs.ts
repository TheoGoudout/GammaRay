// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

// Qt adaptations of Playwright's Dialog ('dialog' event) and FileChooser ('filechooser').
// Qt dialogs are ordinary windows (QDialog, QMessageBox, QFileDialog) or Qt Quick popups
// (Dialog, MessageDialog), so these are thin helpers over locators.

import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QtApp } from './app';
import { step } from './instrumentation';
import type { Locator } from './locator';
import type { ElementInfo } from './types';

const isFileDialog = (info: ElementInfo) =>
  info.typeNames.includes('QFileDialog') || info.typeNames.some((t) => t.includes('FileDialogImpl'));

/** Selector matching shown dialogs: visible QDialogs and opened Qt Quick dialogs. */
export const DIALOG_SELECTOR = 'QDialog >> visible=true >> or="Dialog[opened=true]"';

export class Dialog {
  /** The dialog element. */
  readonly locator: Locator;

  constructor(
    private readonly app: QtApp,
    readonly info: ElementInfo,
  ) {
    this.locator = app.locator(`handle=${info.handle}`).describe(`dialog ${info.text ?? info.type}`);
  }

  private get isQuick(): boolean {
    return this.info.typeNames.includes('QQuickPopup');
  }

  /** 'messagebox' (QMessageBox / MessageDialog) or 'dialog'. */
  type(): 'messagebox' | 'dialog' {
    return this.info.typeNames.some((t) => t === 'QMessageBox' || t.includes('MessageDialog')) ? 'messagebox' : 'dialog';
  }

  async title(): Promise<string> {
    return (await this.locator.getProperty<string>(this.isQuick ? 'title' : 'windowTitle')) ?? '';
  }

  /** The message: QMessageBox text, else the first text inside the dialog, else the title. */
  async message(): Promise<string> {
    if (this.info.typeNames.includes('QMessageBox')) return this.locator.getProperty<string>('text');
    const texts = this.locator.getByRole('text');
    if ((await texts.count()) > 0) return texts.first().textContent();
    return this.title();
  }

  /** Accepts like a user: Enter (default button) for widget dialogs, accept() for Qt Quick ones. */
  async accept(): Promise<void> {
    await step(`${this.locator}.accept`, async () => {
      if (this.isQuick) await this.locator.invoke('accept');
      else await this.locator.press('Enter');
    });
  }

  /** Dismisses like a user: Escape for widget dialogs, reject() for Qt Quick ones. */
  async dismiss(): Promise<void> {
    await step(`${this.locator}.dismiss`, async () => {
      if (this.isQuick) await this.locator.invoke('reject');
      else await this.locator.press('Escape');
    });
  }
}

export class FileChooser {
  readonly locator: Locator;

  constructor(
    private readonly app: QtApp,
    readonly info: ElementInfo,
  ) {
    this.locator = app.locator(`handle=${info.handle}`).describe('file chooser');
  }

  /** Whether several files can be chosen (QFileDialog::ExistingFiles). */
  async isMultiple(): Promise<boolean> {
    if (!this.info.typeNames.includes('QFileDialog')) return false;
    return (await this.locator.getProperty('fileMode')) === 'ExistingFiles';
  }

  /**
   * Chooses @p files and accepts the dialog: types the path(s) into the file name field and
   * presses Enter, like a user (relative paths are resolved against the test's cwd).
   */
  async setFiles(files: string | string[]): Promise<void> {
    const list = (Array.isArray(files) ? files : [files]).map((f) => (isAbsolute(f) ? f : resolve(f)));
    await step(`${this.locator}.setFiles`, async () => {
      if (this.info.typeNames.includes('QFileDialog')) {
        const text = list.length === 1 ? list[0] : list.map((f) => JSON.stringify(f)).join(' ');
        const edit = this.locator.locator('#fileNameEdit');
        await edit.fill(text);
        await edit.press('Enter');
        return;
      }
      // Qt Quick FileDialog (non-native implementation)
      await this.locator.setProperty('selectedFile', pathToFileURL(list[0]).href);
      await this.locator.invoke('accept');
    });
  }
}

export async function findDialogs(app: QtApp): Promise<ElementInfo[]> {
  const r = await app.connection.call<{ elements: ElementInfo[] }>('query', { selector: DIALOG_SELECTOR, describe: true });
  return r.elements;
}

export { isFileDialog };
