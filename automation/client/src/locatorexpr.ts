// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

// Locator expressions as written in tests, e.g.
//   getByRole('button', { name: 'Login' })
//   app.locator('#loginBox').getByLabel(/user/i).first()
//   getByRole('listitem').filter({ has: getByText('Done') }).nth(2)
// are parsed into Locators without evaluating JavaScript: only literals (strings, numbers,
// booleans, regular expressions, arrays, objects, nested locator expressions) and the
// locator-building methods below are accepted. Anything else is a selector string
// (see Locator), e.g. `#loginButton` or `QPushButton[text="OK"]`.

import type { QtApp } from './app';
import { Locator } from './locator';

/** Methods that build locators from the application. */
const APP_METHODS = new Set(['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTitle', 'getByTestId', 'getById']);
/** Methods that build locators from a locator. */
const LOCATOR_METHODS = new Set([
  'locator',
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByTitle',
  'getByTestId',
  'filter',
  'and',
  'or',
  'first',
  'last',
  'nth',
  'visible',
  'describe',
]);

/** An invalid locator expression; the message points at the offending position. */
export class LocatorExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocatorExpressionError';
  }
}

type Value = string | number | boolean | null | undefined | RegExp | Value[] | { [key: string]: Value } | Locator;

class Parser {
  private pos = 0;

  constructor(
    private readonly text: string,
    private readonly app: QtApp,
  ) {}

  private fail(what: string): never {
    const near = this.text.slice(this.pos, this.pos + 20);
    throw new LocatorExpressionError(`invalid locator expression at position ${this.pos}${near ? ` ("${near}")` : ''}: ${what}`);
  }

  private skipSpace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) ++this.pos;
  }

  private peek(): string {
    this.skipSpace();
    return this.text[this.pos] ?? '';
  }

  private eat(ch: string): boolean {
    if (this.peek() !== ch) return false;
    ++this.pos;
    return true;
  }

  private expect(ch: string): void {
    if (!this.eat(ch)) this.fail(`expected "${ch}"`);
  }

  private identifier(): string {
    this.skipSpace();
    const m = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.pos));
    if (!m) this.fail('expected a name');
    this.pos += m[0].length;
    return m[0];
  }

  /** The whole input: one locator expression. */
  parseAll(): Locator {
    const locator = this.locatorExpression();
    if (this.peek() === ';') ++this.pos;
    if (this.peek() !== '') this.fail('unexpected text after the expression');
    return locator;
  }

  /** [app.]method(args)(.method(args))* */
  private locatorExpression(): Locator {
    let name = this.identifier();
    if (name === 'app' || name === 'page') {
      this.expect('.');
      name = this.identifier();
    }
    let current: QtApp | Locator = this.app;
    for (;;) {
      const allowed = current === this.app ? APP_METHODS : LOCATOR_METHODS;
      if (!allowed.has(name)) this.fail(`${name}() is not a locator method (use ${[...allowed].join(', ')})`);
      const args = this.argumentList();
      // describe() without a description queries the element instead of building a locator
      if (name === 'describe' && typeof args[0] !== 'string') this.fail('describe() needs a description string');
      try {
        current = (current as any)[name](...args) as Locator;
      } catch (e) {
        this.fail(`${name}(): ${(e as Error).message}`);
      }
      if (!(current instanceof Locator)) this.fail(`${name}() did not return a locator`);
      if (!this.eat('.')) return current;
      name = this.identifier();
    }
  }

  private argumentList(): Value[] {
    this.expect('(');
    const args: Value[] = [];
    while (!this.eat(')')) {
      args.push(this.value());
      if (!this.eat(',') && this.peek() !== ')') this.fail('expected "," or ")"');
    }
    return args;
  }

  private value(): Value {
    const ch = this.peek();
    if (ch === "'" || ch === '"' || ch === '`') return this.string();
    if (ch === '/') return this.regex();
    if (ch === '{') return this.object();
    if (ch === '[') return this.array();
    if (ch === '-' || /\d/.test(ch)) return this.number();
    const save = this.pos;
    const name = this.identifier();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    if (name === 'undefined') return undefined;
    this.pos = save;
    return this.locatorExpression();
  }

  private number(): number {
    this.skipSpace();
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (!m) this.fail('expected a number');
    this.pos += m[0].length;
    return Number(m[0]);
  }

  private string(): string {
    const quote = this.text[this.pos++];
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) this.fail('unterminated string');
      const c = this.text[this.pos++];
      if (c === quote) return out;
      if (quote === '`' && c === '$' && this.text[this.pos] === '{') this.fail('template literals with ${} are not supported');
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = this.text[this.pos++];
      const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
      if (e in simple) out += simple[e];
      else if (e === 'u') {
        const m = /^(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/.exec(this.text.slice(this.pos));
        if (!m) this.fail('invalid \\u escape');
        out += String.fromCodePoint(parseInt(m[1] ?? m[2], 16));
        this.pos += m[0].length;
      } else if (e === 'x') {
        const m = /^[0-9a-fA-F]{2}/.exec(this.text.slice(this.pos));
        if (!m) this.fail('invalid \\x escape');
        out += String.fromCharCode(parseInt(m[0], 16));
        this.pos += 2;
      } else if (e !== undefined) out += e; // \\ \' \" and any other escaped character
    }
  }

  private regex(): RegExp {
    const start = ++this.pos;
    let inClass = false;
    for (;;) {
      if (this.pos >= this.text.length) this.fail('unterminated regular expression');
      const c = this.text[this.pos];
      if (c === '\\') this.pos += 2;
      else {
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        ++this.pos;
      }
    }
    const source = this.text.slice(start, this.pos++);
    const flags = /^[a-z]*/.exec(this.text.slice(this.pos))![0];
    this.pos += flags.length;
    try {
      return new RegExp(source, flags);
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  private object(): { [key: string]: Value } {
    this.expect('{');
    const out: { [key: string]: Value } = {};
    while (!this.eat('}')) {
      const ch = this.peek();
      const key = ch === "'" || ch === '"' ? this.string() : this.identifier();
      this.expect(':');
      out[key] = this.value();
      if (!this.eat(',') && this.peek() !== '}') this.fail('expected "," or "}"');
    }
    return out;
  }

  private array(): Value[] {
    this.expect('[');
    const out: Value[] = [];
    while (!this.eat(']')) {
      out.push(this.value());
      if (!this.eat(',') && this.peek() !== ']') this.fail('expected "," or "]"');
    }
    return out;
  }
}

/** Whether @p text is a locator expression (`getByRole(...)`) rather than a selector (`#ok`). */
export function isLocatorExpression(text: string): boolean {
  return /^\s*(?:(?:app|page)\s*\.\s*)?[A-Za-z_$][\w$]*\s*\(/.test(text);
}

/**
 * A Locator for @p text: a locator expression as in tests (`getByRole('button', { name: 'OK' })`,
 * optionally starting with `app.`), or else a selector (`#okButton`).
 */
export function parseLocator(app: QtApp, text: string): Locator {
  if (!text.trim()) throw new LocatorExpressionError('empty locator');
  if (!isLocatorExpression(text)) return app.locator(text.trim());
  return new Parser(text, app).parseAll();
}
