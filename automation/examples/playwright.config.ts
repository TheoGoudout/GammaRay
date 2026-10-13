// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { defineConfig } from '@playwright/test';
import path from 'node:path';
import type { QtOptions } from 'qt-playwright/test';

// Paths can be overridden for out-of-tree builds:
//   QTPW_SAMPLEAPP       the sample application binary
//   QT_PLAYWRIGHT_GAMMARAY the gammaray launcher (else `gammaray` from PATH)
const sampleApp = process.env.QTPW_SAMPLEAPP ?? path.resolve(__dirname, 'sampleapp/build/sampleapp');

export default defineConfig<QtOptions>({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    qtApp: { executable: sampleApp },
    qtScreenshot: 'only-on-failure',
    actionTimeout: 5_000,
  },
});
