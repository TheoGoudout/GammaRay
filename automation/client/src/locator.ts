// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { writeFile } from 'node:fs/promises';
import type { QtApp } from './app';
import { ErrorCode, QtError, StrictModeViolationError } from './errors';
import { step } from './instrumentation';
import {
  labelSelector,
  propertySelector,
  quote,
  roleSelector,
  textSelector,
  textValue,
  type AriaRole,
  type ByRoleOptions,
} from './selectors';
import { SignalSpy } from './signalspy';
import type {
  ActionOptions,
  ClickOptions,
  SelectOption,
  TypeOptions,
  DragOptions,
  ElementInfo,
  ElementRef,
  PointerOptions,
  Rect,
  ScreenshotOptions,
  ScrollOptions,
  TimeoutOptions,
  WaitForState,
} from './types';
import { renderAriaSnapshot, type AriaNode } from './aria';
import { poll, sleep } from './wait';

export interface Actionability {
  attached: boolean;
  visible?: boolean;
  enabled?: boolean;
  /** -1: not an input, 0: read-only or disabled, 1: editable */
  editable?: number;
  hasGeometry?: boolean;
  geometry?: Rect;
  viewportRatio?: number;
  blockedBy?: string;
}

export interface FilterOptions {
  /** Keep elements containing (themselves or in a descendant) this text: substring, case-insensitive. */
  hasText?: string | RegExp;
  hasNotText?: string | RegExp;
  /** Keep elements with a descendant matching this (relative) locator. */
  has?: Locator;
  hasNot?: Locator;
  /** Keep only visible (true) or hidden (false) elements. */
  visible?: boolean;
}

/** A JavaScript function (or its source) run inside the application by Qt's JS engine. */
export type PageFunction<Arg, R> = string | ((element: any, arg: Arg) => R);
export type PageFunctionAll<Arg, R> = string | ((elements: any[], arg: Arg) => R);

/** Locators passed as `arg` are resolved to their element; other values must be JSON. */
export async function serializeArg(arg: unknown): Promise<unknown> {
  if (arg instanceof Locator) return { handle: await arg.handle() };
  return arg === undefined ? null : arg;
}

interface Requirements {
  visible?: boolean;
  enabled?: boolean;
  editable?: boolean;
  stable?: boolean;
  receivesEvents?: boolean;
}

export { quote, textSelector } from './selectors';

function sameRect(a?: Rect, b?: Rect): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function describeRef(e: ElementRef): string {
  let s = e.type;
  if (e.id) s += ` id=${e.id}`;
  if (e.objectName) s += ` objectName=${e.objectName}`;
  return s;
}

/**
 * A lazy reference to element(s) in the application, described by a selector.
 *
 * Nothing is looked up until an action or query runs; every action re-resolves the
 * selector and waits for the element to be actionable, so locators survive the
 * underlying objects being re-created.
 *
 * Selector syntax (segments joined with `>>` search descendants of the previous match):
 *  - `#name`                objectName or QML id
 *  - `QPushButton`, `Button` C++ class (incl. base classes) or QML type
 *  - `text="Save"`          exact text; `text=save` case-insensitive substring; `text=/re/i`
 *  - `[checked=true]`       property filter (`=`, `!=`, `*=` contains, `[prop]` truthy)
 *  - `nth=2`, `first`, `last` pick one of the matches so far
 *  - `visible=true`          keep only visible matches
 * Segments can be combined: `Button#ok[enabled=true]`.
 */
export class Locator {
  constructor(
    readonly app: QtApp,
    readonly selector: string,
    /** Human-readable description (see describe(description)). */
    readonly description?: string,
  ) {}

  toString(): string {
    return this.description ? `${this.description} (locator(${quote(this.selector)}))` : `locator(${quote(this.selector)})`;
  }

  private derive(selector: string): Locator {
    return new Locator(this.app, selector);
  }

  // --- composition -----------------------------------------------------------------

  /** Elements matching @p selector below the elements matched by this locator. */
  locator(selector: string | Locator, options: FilterOptions = {}): Locator {
    const sub = selector instanceof Locator ? selector.selector : selector;
    return this.derive(`${this.selector} >> ${sub}`).filter(options);
  }

  /** Elements below this one whose text matches (case-insensitive substring unless exact). */
  getByText(text: string | RegExp, options: { exact?: boolean } = {}): Locator {
    return this.locator(textSelector(text, options.exact));
  }

  /** Elements by accessibility role and name, like Playwright's getByRole. */
  getByRole(role: AriaRole | string, options: ByRoleOptions = {}): Locator {
    return this.locator(roleSelector(role, options));
  }

  /** Inputs by their label (QLabel buddy / form label, Accessible.name or the control's own text). */
  getByLabel(text: string | RegExp, options: { exact?: boolean } = {}): Locator {
    return this.locator(labelSelector(text, options.exact));
  }

  /** Inputs by placeholder text (placeholderText property). */
  getByPlaceholder(text: string | RegExp, options: { exact?: boolean } = {}): Locator {
    return this.locator(propertySelector('placeholderText', text, options.exact));
  }

  /** Elements by tooltip (toolTip property, the closest thing to a title attribute). */
  getByTitle(text: string | RegExp, options: { exact?: boolean } = {}): Locator {
    return this.locator(propertySelector('toolTip', text, options.exact));
  }

  /** Elements by test id: the property set with app.setTestIdAttribute() (default objectName). */
  getByTestId(testId: string | RegExp): Locator {
    return this.locator(propertySelector(this.app.testIdAttribute, testId, true));
  }

  /** Narrows the matches, like Playwright's locator.filter(). */
  filter(options: FilterOptions = {}): Locator {
    let s = this.selector;
    if (options.hasText !== undefined) s += ` >> hasText=${textValue(options.hasText)}`;
    if (options.hasNotText !== undefined) s += ` >> hasNotText=${textValue(options.hasNotText)}`;
    if (options.has) s += ` >> has=${quote(options.has.selector)}`;
    if (options.hasNot) s += ` >> hasNot=${quote(options.hasNot.selector)}`;
    if (options.visible !== undefined) s += ` >> visible=${options.visible}`;
    return s === this.selector ? this : this.derive(s);
  }

  /** Elements matching both this and @p other. */
  and(other: Locator): Locator {
    return this.derive(`${this.selector} >> and=${quote(other.selector)}`);
  }

  /** Elements matching either this or @p other (in document order). */
  or(other: Locator): Locator {
    return this.derive(`${this.selector} >> or=${quote(other.selector)}`);
  }

  first(): Locator {
    return this.nth(0);
  }

  last(): Locator {
    return this.nth(-1);
  }

  /** The n-th match (0-based; negative counts from the end). */
  nth(index: number): Locator {
    return this.derive(`${this.selector} >> nth=${index}`);
  }

  /** Only the visible matches. */
  visible(): Locator {
    return this.derive(`${this.selector} >> visible=true`);
  }

  // --- resolution --------------------------------------------------------------------

  /** Current matches, without waiting. */
  async elements(): Promise<ElementRef[]> {
    const r = await this.app.connection.call<{ elements: ElementRef[] }>('query', { selector: this.selector });
    return r.elements;
  }

  /** Number of elements currently matching, without waiting. */
  async count(): Promise<number> {
    return (await this.elements()).length;
  }

  /** A locator for each current match. */
  async all(): Promise<Locator[]> {
    const n = await this.count();
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }

  private strictCheck(elements: ElementRef[]): void {
    if (elements.length > 1) {
      const list = elements
        .slice(0, 10)
        .map((e, i) => `    ${i + 1}) ${describeRef(e)}`)
        .join('\n');
      throw new StrictModeViolationError(
        `strict mode violation: ${this} resolved to ${elements.length} elements:\n${list}\n` +
          `Use a more specific selector, or .first(), .last(), .nth(i).`,
      );
    }
  }

  /** Waits until exactly one element matches; returns its handle. */
  async handle(options: TimeoutOptions = {}): Promise<number> {
    const timeout = options.timeout ?? this.app.defaultTimeout;
    return poll(`${this}.handle`, timeout, async () => {
      const elements = await this.elements();
      this.strictCheck(elements);
      if (elements.length === 0) return { done: false, log: `waiting for ${this}` };
      return { done: true, value: elements[0].handle };
    });
  }

  /**
   * Resolves the element and waits until it meets @p req, then runs @p perform.
   * Retries from scratch if the element goes away in between.
   */
  private async act<T>(
    name: string,
    options: ActionOptions & { position?: { x: number; y: number } },
    req: Requirements,
    perform: (handle: number) => Promise<T>,
  ): Promise<T> {
    const timeout = options.timeout ?? this.app.defaultTimeout;
    const force = options.force ?? false;
    return step(`${this}.${name}`, () =>
      poll(`${this}.${name}`, timeout, async () => {
        const elements = await this.elements();
        this.strictCheck(elements);
        if (elements.length === 0) return { done: false, log: `waiting for ${this}` };
        const handle = elements[0].handle;

        if (!force) {
          const needsHitTest = !!req.receivesEvents;
          // like a user would, scroll enclosing Flickables/scroll areas to reveal the element
          if (needsHitTest) await this.app.connection.call('scrollIntoView', { handle });
          let state = await this.app.connection.call<Actionability>('actionability', {
            handle,
            position: options.position,
            checkHitTarget: needsHitTest,
          });
          const waitingFor = (why: string) => ({ done: false, log: `${describeRef(elements[0])}: ${why}` });
          if (!state.attached) return waitingFor('element was detached');
          if (req.visible && !state.visible) return waitingFor('element is not visible');
          if (req.enabled && !state.enabled) return waitingFor('element is not enabled');
          if (req.editable && state.editable === -1)
            throw new Error(`${this}: ${describeRef(elements[0])} is not an editable element (no readOnly/editable property)`);
          if (req.editable && state.editable === 0) return waitingFor('element is not editable');
          if (req.stable && state.hasGeometry) {
            // stable = same bounding box over two checks one frame apart
            await sleep(16);
            const again = await this.app.connection.call<Actionability>('actionability', {
              handle,
              position: options.position,
              checkHitTarget: needsHitTest,
            });
            if (!again.attached) return waitingFor('element was detached');
            if (!sameRect(state.geometry, again.geometry)) return waitingFor('element is not stable (moving)');
            state = again;
          }
          if (needsHitTest && state.blockedBy) return waitingFor(`element does not receive pointer events, ${state.blockedBy} intercepts them`);
        }

        if (options.trial) return { done: true, value: undefined as T };
        try {
          const value = await perform(handle);
          if (this.app.slowMo) await sleep(this.app.slowMo);
          return { done: true, value };
        } catch (e) {
          if (e instanceof QtError && (e.code === ErrorCode.StaleHandle || e.code === ErrorCode.NotActionable))
            return { done: false, log: `retrying: ${e.message}` };
          throw e;
        }
      }),
    );
  }

  private pointerParams(options: PointerOptions) {
    return { position: options.position, modifiers: options.modifiers };
  }

  // --- actions -----------------------------------------------------------------------

  /** Clicks the element (by default in its center) after it is visible, enabled, stable and unobstructed. */
  async click(options: ClickOptions = {}): Promise<void> {
    await this.act('click', options, { visible: true, enabled: true, stable: true, receivesEvents: true }, (handle) =>
      this.app.connection.call('click', {
        handle,
        ...this.pointerParams(options),
        button: options.button,
        clickCount: options.clickCount ?? 1,
        delay: options.delay,
      }),
    );
  }

  async dblclick(options: Omit<ClickOptions, 'clickCount'> = {}): Promise<void> {
    await this.act('dblclick', options, { visible: true, enabled: true, stable: true, receivesEvents: true }, (handle) =>
      this.app.connection.call('doubleClick', { handle, ...this.pointerParams(options), button: options.button }),
    );
  }

  /** Moves the mouse over the element. */
  async hover(options: PointerOptions = {}): Promise<void> {
    await this.act('hover', options, { visible: true, stable: true, receivesEvents: true }, (handle) =>
      this.app.connection.call('hover', { handle, ...this.pointerParams(options) }),
    );
  }

  /** Focuses the element, selects all its text, and types @p value with real key events. */
  async fill(value: string, options: ActionOptions = {}): Promise<void> {
    await this.act('fill', options, { visible: true, enabled: true, editable: true }, (handle) =>
      this.app.connection.call('fill', { handle, text: value }),
    );
  }

  /** Clears the element's text. */
  async clear(options: ActionOptions = {}): Promise<void> {
    await this.fill('', options);
  }

  /** Focuses the element and types @p text key by key (without clearing). */
  async pressSequentially(text: string, options: TypeOptions = {}): Promise<void> {
    await this.act('pressSequentially', options, { visible: true, enabled: true }, async (handle) => {
      if (!options.delay || text.length < 2) return this.app.connection.call('type', { handle, text });
      // focus once, then key by key with the requested delay
      await this.app.connection.call('type', { handle, text: text[0] });
      for (const ch of text.slice(1)) {
        await sleep(options.delay);
        await this.app.connection.call('type', { text: ch });
      }
    });
  }

  /** Alias of pressSequentially(). */
  async type(text: string, options: TypeOptions = {}): Promise<void> {
    await this.pressSequentially(text, options);
  }

  /** Focuses the element and presses a key or combination, e.g. "Enter", "Control+A", "Shift+ArrowDown". */
  async press(key: string, options: ActionOptions = {}): Promise<void> {
    await this.act('press', options, { visible: true, enabled: true }, (handle) =>
      this.app.connection.call('press', { handle, key }),
    );
  }

  /** Scrolls enclosing Flickables / QScrollAreas so the element is fully visible. */
  async scrollIntoViewIfNeeded(options: ActionOptions = {}): Promise<void> {
    await this.act('scrollIntoViewIfNeeded', options, { visible: true }, (handle) =>
      this.app.connection.call('scrollIntoView', { handle }),
    );
  }

  /** Removes keyboard focus from the element. */
  async blur(options: TimeoutOptions = {}): Promise<void> {
    await step(`${this}.blur`, async () => {
      await this.app.connection.call('blur', { handle: await this.handle(options) });
    });
  }

  /** Taps the element with a (synthetic) touch screen. */
  async tap(options: PointerOptions = {}): Promise<void> {
    await this.act('tap', options, { visible: true, enabled: true, stable: true, receivesEvents: true }, (handle) =>
      this.app.connection.call('tap', { handle, position: options.position }),
    );
  }

  /** Focuses the element and selects all its text. */
  async selectText(options: ActionOptions = {}): Promise<void> {
    await this.act('selectText', options, { visible: true }, async (handle) => {
      await this.app.connection.call('focus', { handle });
      try {
        await this.app.connection.call('invokeMethod', { handle, method: 'selectAll', args: [] });
      } catch (e) {
        if (!(e instanceof QtError && e.code === ErrorCode.NotFound)) throw e;
        await this.app.connection.call('press', { handle, key: 'Control+A' });
      }
    });
  }

  /**
   * Selects an option of a QComboBox or QML ComboBox like a user: opens the popup and
   * clicks the item. Strings match the item text (label) or, failing that, its value
   * (item data / valueRole). Returns the selected labels.
   */
  async selectOption(values: SelectOption | SelectOption[], options: ActionOptions = {}): Promise<string[]> {
    const wanted = Array.isArray(values) ? values : [values];
    if (wanted.length !== 1) throw new Error(`${this}.selectOption: Qt combo boxes select exactly one option`);
    const option = typeof wanted[0] === 'string' ? { label: wanted[0], value: wanted[0] } : wanted[0];
    return step(`${this}.selectOption`, async () => {
      const info = await this.describe({ timeout: options.timeout });
      if (info.typeNames.includes('QComboBox')) {
        return this.act('selectOption', options, { visible: true, enabled: true, stable: true, receivesEvents: true }, async (handle) => {
          const attempts = option.index !== undefined ? [{ index: option.index }] : [
            ...(option.label !== undefined ? [{ label: option.label }] : []),
            ...(option.value !== undefined ? [{ value: option.value }] : []),
          ];
          let lastError: unknown;
          for (const params of attempts) {
            try {
              const r = await this.app.connection.call<{ selected: string[] }>('selectOption', { handle, ...params });
              return r.selected;
            } catch (e) {
              if (!(e instanceof QtError && e.code === ErrorCode.NotFound)) throw e;
              lastError = e;
            }
          }
          throw lastError;
        });
      }
      if (info.typeNames.includes('QQuickComboBox')) {
        let index = option.index ?? -1;
        if (index < 0 && option.label !== undefined) index = await this.invoke<number>('find', option.label);
        if (index < 0 && option.value !== undefined) index = await this.invoke<number>('indexOfValue', option.value);
        if (index < 0) throw new Error(`${this}.selectOption: no option matches ${JSON.stringify(wanted[0])}`);
        const label = await this.invoke<string>('textAt', index);
        await this.click(options);
        // the popup's list delegates are ordinary items below the combo box's Popup
        await this.locator('Popup').getByText(label, { exact: true }).visible().click(options);
        return [label];
      }
      throw new Error(`${this}.selectOption: ${info.type} is not a QComboBox or QML ComboBox`);
    });
  }

  /**
   * Qt adaptation of setInputFiles(): clicks the element (a button opening a file dialog),
   * waits for the file dialog and chooses @p files in it.
   */
  async setInputFiles(files: string | string[], options: ClickOptions = {}): Promise<void> {
    await step(`${this}.setInputFiles`, async () => {
      const chooser = this.app.waitForFileChooser({ timeout: options.timeout });
      await this.click(options);
      await (await chooser).setFiles(files);
    });
  }

  /** Gives keyboard focus to the element. */
  async focus(options: ActionOptions = {}): Promise<void> {
    await this.act('focus', options, { visible: true }, (handle) => this.app.connection.call('focus', { handle }));
  }

  /** Sends a mouse wheel event over the element. */
  async scroll(options: ScrollOptions): Promise<void> {
    await this.act('scroll', options, { visible: true, stable: true, receivesEvents: true }, (handle) =>
      this.app.connection.call('scroll', {
        handle,
        ...this.pointerParams(options),
        deltaX: options.deltaX ?? 0,
        deltaY: options.deltaY ?? 0,
      }),
    );
  }

  /** Presses the mouse on this element, moves to @p target and releases there. */
  async dragTo(target: Locator, options: DragOptions = {}): Promise<void> {
    const targetHandle = await target.handle({ timeout: options.timeout });
    await this.act('dragTo', { ...options, position: options.sourcePosition }, { visible: true, enabled: true, stable: true, receivesEvents: true }, (handle) =>
      this.app.connection.call('drag', {
        handle,
        target: targetHandle,
        position: options.sourcePosition,
        targetPosition: options.targetPosition,
        steps: options.steps,
        button: options.button,
        modifiers: options.modifiers,
      }),
    );
  }

  /** Drags the element by a pixel offset. */
  async dragBy(dx: number, dy: number, options: DragOptions = {}): Promise<void> {
    await this.act('dragBy', { ...options, position: options.sourcePosition }, { visible: true, enabled: true, stable: true, receivesEvents: true }, (handle) =>
      this.app.connection.call('drag', {
        handle,
        offset: { x: dx, y: dy },
        position: options.sourcePosition,
        steps: options.steps,
        button: options.button,
        modifiers: options.modifiers,
      }),
    );
  }

  /** Ensures a checkable element (checkbox, toggle button...) is checked, clicking it if needed. */
  async check(options: ClickOptions = {}): Promise<void> {
    await this.setChecked(true, options);
  }

  async uncheck(options: ClickOptions = {}): Promise<void> {
    await this.setChecked(false, options);
  }

  async setChecked(checked: boolean, options: ClickOptions = {}): Promise<void> {
    await step(`${this}.setChecked(${checked})`, async () => {
      if ((await this.isChecked(options)) === checked) return;
      await this.click(options);
      await poll(`${this}.setChecked`, options.timeout ?? this.app.defaultTimeout, async () => {
        const now = await this.isChecked(options);
        return { done: now === checked, log: `waiting for checked to become ${checked}` };
      });
    });
  }

  // --- queries -----------------------------------------------------------------------

  /** Reads a Qt property (Q_PROPERTY, QML property or dynamic property). */
  async getProperty<T = any>(name: string, options: TimeoutOptions = {}): Promise<T> {
    const handle = await this.handle(options);
    return (await this.app.connection.call<{ value: T }>('getProperty', { handle, name })).value;
  }

  /** All readable properties and their current values. */
  async getProperties(options: TimeoutOptions = {}): Promise<Record<string, unknown>> {
    const handle = await this.handle(options);
    return (await this.app.connection.call<{ properties: Record<string, unknown> }>('getProperties', { handle })).properties;
  }

  /** Writes a Qt property. Enums accept key names, colors "#rrggbb", geometry types {x,y,...}. */
  async setProperty(name: string, value: unknown, options: TimeoutOptions = {}): Promise<void> {
    await step(`${this}.setProperty(${quote(name)})`, async () => {
      const handle = await this.handle(options);
      await this.app.connection.call('setProperty', { handle, name, value });
    });
  }

  /**
   * Invokes a slot, Q_INVOKABLE or QML function with JSON-convertible arguments; returns its result.
   * Pass a Locator's handle as `{ handle }` to supply a QObject argument.
   */
  async invoke<T = any>(method: string, ...args: unknown[]): Promise<T> {
    return step(`${this}.invoke(${quote(method)})`, async () => {
      const handle = await this.handle();
      return (await this.app.connection.call<{ value: T }>('invokeMethod', { handle, method, args })).value;
    });
  }

  /** The element's text (text, plainText, currentText or title property). */
  async textContent(options: TimeoutOptions = {}): Promise<string> {
    const handle = await this.handle(options);
    return (await this.app.connection.call<{ value: string }>('text', { handle })).value;
  }

  /** Alias of textContent(). */
  async innerText(options: TimeoutOptions = {}): Promise<string> {
    return this.textContent(options);
  }

  /** Current text of an editable element. */
  async inputValue(options: TimeoutOptions = {}): Promise<string> {
    return this.textContent(options);
  }

  /** Whether the element exists and is visible right now (no waiting; false if not found). */
  async isVisible(): Promise<boolean> {
    const elements = await this.elements();
    this.strictCheck(elements);
    if (elements.length === 0) return false;
    const s = await this.app.connection.call<Actionability>('actionability', { handle: elements[0].handle, checkHitTarget: false });
    return !!s.attached && !!s.visible;
  }

  async isHidden(): Promise<boolean> {
    return !(await this.isVisible());
  }

  async isEnabled(options: TimeoutOptions = {}): Promise<boolean> {
    const handle = await this.handle(options);
    return (await this.app.connection.call<{ value: boolean }>('isEnabled', { handle })).value;
  }

  async isDisabled(options: TimeoutOptions = {}): Promise<boolean> {
    return !(await this.isEnabled(options));
  }

  /** Value of the `checked` property (QAbstractButton, QAction, QML AbstractButton...). */
  async isChecked(options: TimeoutOptions = {}): Promise<boolean> {
    return !!(await this.getProperty('checked', options));
  }

  /** Bounding box in global coordinates, or null if the element is not visible. */
  async boundingBox(options: TimeoutOptions = {}): Promise<Rect | null> {
    const handle = await this.handle(options);
    const info = await this.app.connection.call<ElementInfo>('describe', { handle });
    return info.visible && info.geometry ? info.geometry : null;
  }

  /**
   * describe(): full description of the element (types, ids, text, role, state, geometry).
   * describe(text): like Playwright, a copy of this locator labeled with @p text in errors/traces.
   */
  describe(options?: TimeoutOptions): Promise<ElementInfo>;
  describe(description: string): Locator;
  describe(arg: TimeoutOptions | string = {}): Promise<ElementInfo> | Locator {
    if (typeof arg === 'string') return new Locator(this.app, this.selector, arg);
    return this.handle(arg).then((handle) => this.app.connection.call<ElementInfo>('describe', { handle }));
  }

  /** Accessibility tree of the element as YAML, like Playwright's ariaSnapshot(). */
  async ariaSnapshot(options: TimeoutOptions = {}): Promise<string> {
    const handle = await this.handle(options);
    const r = await this.app.connection.call<{ nodes: AriaNode[] }>('ariaSnapshot', { handle });
    return renderAriaSnapshot(r.nodes);
  }

  /**
   * Runs @p fn inside the application with the element as first argument: a JavaScript
   * wrapper of the QObject (properties, slots, Q_INVOKABLEs, signals). QML elements are
   * evaluated by their own QML engine. Returns the JSON-converted result.
   *
   *   await locator.evaluate((el, suffix) => el.text + suffix, '!')
   */
  async evaluate<R = any, Arg = unknown>(fn: PageFunction<Arg, R>, arg?: Arg, options: TimeoutOptions = {}): Promise<R> {
    return step(`${this}.evaluate`, async () => {
      const handle = await this.handle(options);
      const r = await this.app.connection.call<{ value: R }>('evaluate', {
        handle,
        function: fn.toString(),
        arg: await serializeArg(arg),
      });
      return r.value;
    });
  }

  /** Like evaluate(), with an array of all matching elements (no waiting, may be empty). */
  async evaluateAll<R = any, Arg = unknown>(fn: PageFunctionAll<Arg, R>, arg?: Arg): Promise<R> {
    return step(`${this}.evaluateAll`, async () => {
      const handles = (await this.elements()).map((e) => e.handle);
      const r = await this.app.connection.call<{ value: R }>('evaluate', {
        handles,
        function: fn.toString(),
        arg: await serializeArg(arg),
      });
      return r.value;
    });
  }

  /** Waits for the element to reach @p state (default "visible"). */
  async waitFor(options: TimeoutOptions & { state?: WaitForState } = {}): Promise<void> {
    const state = options.state ?? 'visible';
    await step(`${this}.waitFor(${state})`, () =>
      poll(`${this}.waitFor(${state})`, options.timeout ?? this.app.defaultTimeout, async () => {
        const elements = await this.elements();
        if (state === 'detached') return { done: elements.length === 0, log: `waiting for ${this} to be detached` };
        if (state === 'attached') return { done: elements.length > 0, log: `waiting for ${this}` };
        this.strictCheck(elements);
        let visible = false;
        if (elements.length === 1) {
          const s = await this.app.connection.call<Actionability>('actionability', { handle: elements[0].handle, checkHitTarget: false });
          visible = !!s.attached && !!s.visible;
        }
        return state === 'visible'
          ? { done: visible, log: `waiting for ${this} to be visible` }
          : { done: !visible, log: `waiting for ${this} to be hidden` };
      }),
    );
  }

  /** PNG screenshot of the element (or its window). */
  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    return this.act('screenshot', options, { visible: true, stable: true }, async (handle) => {
      const mask: number[] = [];
      for (const m of options.mask ?? []) for (const e of await m.elements()) mask.push(e.handle);
      const r = await this.app.connection.call<{ png: string }>('screenshot', {
        handle,
        window: !!options.window,
        mask,
        maskColor: options.maskColor,
        caret: options.caret,
      });
      const buf = Buffer.from(r.png, 'base64');
      if (options.path) await writeFile(options.path, buf);
      return buf;
    });
  }

  // --- signals -----------------------------------------------------------------------

  /**
   * Waits for the element to emit @p signal (name or full signature) and returns its arguments.
   * The wait starts when this call reaches the application; to wait for a signal caused by an
   * action, use spy() before the action instead.
   */
  async waitForSignal(signal: string, options: TimeoutOptions = {}): Promise<unknown[]> {
    return step(`${this}.waitForSignal(${quote(signal)})`, async () => {
      const timeout = options.timeout ?? this.app.defaultTimeout;
      const handle = await this.handle({ timeout });
      const r = await this.app.connection.call<{ args: unknown[] }>('waitForSignal', { handle, signal, timeout });
      return r.args;
    });
  }

  /** Starts recording emissions of @p signal. */
  async spy(signal: string, options: TimeoutOptions = {}): Promise<SignalSpy> {
    const handle = await this.handle(options);
    const r = await this.app.connection.call<{ spyId: number }>('spy', { handle, signal });
    return new SignalSpy(this.app, r.spyId, `${this}.${signal}`);
  }
}
