// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

// Builders for the getBy* locators, shared by QtApp and Locator.

/** Quotes @p text for use in a selector (text="..."). */
export function quote(text: string): string {
  return JSON.stringify(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function regexLiteral(re: RegExp): string {
  // RegExp.source already escapes '/'; the selector engine supports the i, s and m flags
  return `/${re.source}/${re.flags.replace(/[^ism]/g, '')}`;
}

/** A text value: exact ("..."), case-insensitive substring ("..."i) or a regex. */
export function textValue(text: string | RegExp, exact?: boolean): string {
  if (text instanceof RegExp) return regexLiteral(text);
  return exact ? quote(text) : `${quote(text)}i`;
}

export function textSelector(text: string | RegExp, exact?: boolean): string {
  return `text=${textValue(text, exact)}`;
}

/** [prop=...] with Playwright's exact/substring semantics. */
export function propertySelector(property: string, value: string | RegExp, exact?: boolean): string {
  if (value instanceof RegExp) return `[${property}=${regexLiteral(value)}]`;
  return exact ? `[${property}=${quote(value)}]` : `[${property}=/${escapeRegExp(value)}/i]`;
}

export interface ByRoleOptions {
  /** Accessible name: case-insensitive substring by default, exact with `exact: true`, or a RegExp. */
  name?: string | RegExp;
  exact?: boolean;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  pressed?: boolean;
  level?: number;
  /** Also match hidden elements (excluded by default, as in Playwright). */
  includeHidden?: boolean;
}

/**
 * ARIA-style roles, derived from Qt's accessibility roles: button, checkbox, radio, textbox,
 * combobox, list, listitem, slider, spinbutton, progressbar, dialog, alert, menubar, menu,
 * menuitem, tab, tablist, toolbar, tooltip, status, group, separator, scrollbar, table, row,
 * cell, columnheader, rowheader, tree, treeitem, link, img, heading, paragraph, window,
 * and "text" for static text. Qt role names in lower case (e.g. "editabletext") work too.
 */
export type AriaRole =
  | 'alert'
  | 'button'
  | 'cell'
  | 'checkbox'
  | 'columnheader'
  | 'combobox'
  | 'dialog'
  | 'generic'
  | 'group'
  | 'heading'
  | 'img'
  | 'link'
  | 'list'
  | 'listitem'
  | 'menu'
  | 'menubar'
  | 'menuitem'
  | 'paragraph'
  | 'progressbar'
  | 'radio'
  | 'row'
  | 'rowheader'
  | 'scrollbar'
  | 'separator'
  | 'slider'
  | 'spinbutton'
  | 'status'
  | 'tab'
  | 'table'
  | 'tablist'
  | 'text'
  | 'textbox'
  | 'toolbar'
  | 'tooltip'
  | 'tree'
  | 'treeitem'
  | 'window';

export function roleSelector(role: AriaRole | string, options: ByRoleOptions = {}): string {
  let s = `role=${role}`;
  if (options.name !== undefined) s += `[name=${textValue(options.name, options.exact)}]`;
  for (const key of ['checked', 'disabled', 'expanded', 'selected', 'pressed'] as const) {
    if (options[key] !== undefined) s += `[${key}=${options[key]}]`;
  }
  if (options.level !== undefined) s += `[level=${options.level}]`;
  if (options.includeHidden) s += '[include-hidden=true]';
  return s;
}

export function labelSelector(text: string | RegExp, exact?: boolean): string {
  return `label=${textValue(text, exact)}`;
}
