#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

// qt-playwright command line:
//   qt-playwright codegen [--output <file>] [--gammaray <path>] [--headless] <app> [app args...]
//   qt-playwright inspect [--port <port>] [--gammaray <path>] [--headless] <app> [app args...]

import { writeFileSync } from 'node:fs';
import { renderAction } from './codegen';
import { launch } from './launcher';

function usage(): never {
  process.stderr.write(
    [
      'Usage: qt-playwright codegen [options] <application> [arguments...]',
      '       qt-playwright inspect [options] <application> [arguments...]',
      '',
      'codegen  launches the application under GammaRay and records your interactions as a',
      '         qt-playwright test. Close the application (or press Ctrl+C) to finish.',
      'inspect  launches the application and opens the inspector: a live view of its windows',
      '         to pick locators, try locators (matches are highlighted in the application)',
      '         and record code.',
      '',
      'Options:',
      '  -o, --output <file>   codegen: write the test to <file> instead of stdout',
      '  --test-name <name>    codegen: name of the generated test',
      '  --port <port>         inspect: port of the inspector (default: any free port)',
      '  --no-open             inspect: only print the inspector URL, do not open a browser',
      '  --gammaray <path>     the gammaray launcher (default: $QT_PLAYWRIGHT_GAMMARAY or PATH)',
      '  --headless            run without a display (QT_QPA_PLATFORM=offscreen)',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

async function inspect(argv: string[]): Promise<void> {
  let gammaray: string | undefined;
  let headless = false;
  let port: number | undefined;
  let open: boolean | undefined;
  while (argv.length && argv[0].startsWith('-')) {
    const opt = argv.shift()!;
    if (opt === '--') break;
    else if (opt === '--port') port = Number(argv.shift());
    else if (opt === '--no-open') open = false;
    else if (opt === '--gammaray') gammaray = argv.shift();
    else if (opt === '--headless') headless = true;
    else usage();
  }
  const [appPath, ...args] = argv;
  if (!appPath) usage();
  const app = await launch(appPath, args, { gammaray, headless, printOutput: false, timeout: 60_000 });
  await app.inspector({ port, open });
  process.stderr.write(`Inspecting ${appPath} (pid ${app.pid}). Close the application or press Ctrl+C to finish.\n`);
  const finish = async () => {
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void finish());
  app.on('close', () => void finish());
}

async function codegen(argv: string[]): Promise<void> {
  let output: string | undefined;
  let gammaray: string | undefined;
  let headless = false;
  let testName: string | undefined;
  while (argv.length && argv[0].startsWith('-')) {
    const opt = argv.shift()!;
    if (opt === '--') break;
    else if (opt === '-o' || opt === '--output') output = argv.shift();
    else if (opt === '--gammaray') gammaray = argv.shift();
    else if (opt === '--headless') headless = true;
    else if (opt === '--test-name') testName = argv.shift();
    else usage();
  }
  const [appPath, ...args] = argv;
  if (!appPath) usage();

  const app = await launch(appPath, args, { gammaray, headless, printOutput: false, timeout: 60_000 });
  let printed = 0;
  const recorder = await app.startCodegen((actions) => {
    // log finished steps (the last one may still be refined, e.g. typing)
    for (; printed < actions.length - 1; ++printed) process.stderr.write(`  ${renderAction(actions[printed])}\n`);
  });
  process.stderr.write(`Recording ${appPath} (pid ${app.pid}). Close the application or press Ctrl+C to finish.\n`);

  let finishing = false;
  const finish = async () => {
    if (finishing) return; // SIGINT closes the app, which reports 'close' as well
    finishing = true;
    const code = await recorder.stop({ testName });
    if (output) {
      writeFileSync(output, code);
      process.stderr.write(`Wrote ${output}\n`);
    } else {
      process.stdout.write(code);
    }
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void finish());
  app.on('close', () => void finish());
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (argv: string[]) => Promise<void>> = { codegen, inspect };
if (commands[command]) {
  commands[command](rest).catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
} else {
  usage();
}
