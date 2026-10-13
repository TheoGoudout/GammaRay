// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

// Accessibility snapshots in Playwright's ARIA snapshot format:
//
//   - group "Login":
//     - textbox "User:": admin
//     - checkbox "Remember me" [checked]
//     - button "Login" [disabled]
//     - text: Welcome, admin!

/** A node of the accessibility tree as reported by the application. */
export interface AriaNode {
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  pressed?: boolean;
  level?: number;
  children?: AriaNode[];
}

function yamlString(s: string): string {
  // quote when YAML would otherwise misread the value
  return /^[\w .,!?'()/+-]*$/.test(s) && !/^\s|\s$/.test(s) && s !== '' ? s : JSON.stringify(s);
}

function attributes(n: AriaNode): string {
  const attrs: string[] = [];
  if (n.checked) attrs.push('checked');
  if (n.disabled) attrs.push('disabled');
  if (n.expanded !== undefined) attrs.push(`expanded=${n.expanded}`);
  if (n.level) attrs.push(`level=${n.level}`);
  if (n.pressed) attrs.push('pressed');
  if (n.selected) attrs.push('selected');
  return attrs.map((a) => ` [${a}]`).join('');
}

function renderNode(n: AriaNode, indent: string, out: string[]): void {
  const children = n.children ?? [];
  if (n.role === 'text') {
    out.push(`${indent}- text: ${yamlString(n.name)}`);
    return;
  }
  let line = `${indent}- ${n.role}`;
  if (n.name) line += ` ${JSON.stringify(n.name)}`;
  line += attributes(n);
  if (children.length) {
    out.push(`${line}:`);
    if (n.value) out.push(`${indent}  - /value: ${yamlString(n.value)}`);
    for (const c of children) renderNode(c, indent + '  ', out);
  } else {
    out.push(n.value ? `${line}: ${yamlString(n.value)}` : line);
  }
}

export function renderAriaSnapshot(nodes: AriaNode[]): string {
  const out: string[] = [];
  for (const n of nodes) renderNode(n, '', out);
  return out.join('\n');
}

// --- templates (expected snapshots) ------------------------------------------------

type Matcher = { kind: 'string'; value: string } | { kind: 'regex'; value: RegExp };

interface TemplateNode {
  role: string;
  name?: Matcher;
  value?: Matcher;
  attrs: Map<string, string>;
  children: TemplateNode[];
  line: number;
}

function parseMatcher(raw: string): Matcher {
  const s = raw.trim();
  const re = /^\/(.*)\/([ims]*)$/.exec(s);
  if (re) return { kind: 'regex', value: new RegExp(re[1], re[2]) };
  if (s.startsWith('"')) return { kind: 'string', value: JSON.parse(s) };
  return { kind: 'string', value: s };
}

function matches(m: Matcher | undefined, actual: string | undefined): boolean {
  if (!m) return true;
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim();
  if (m.kind === 'regex') return m.value.test(actual ?? '');
  return norm(m.value) === norm(actual ?? '');
}

/** Parses a template like Playwright's toMatchAriaSnapshot() argument. */
export function parseAriaTemplate(text: string): TemplateNode[] {
  const lines = text.split('\n');
  const roots: TemplateNode[] = [];
  const stack: { indent: number; node?: TemplateNode; children: TemplateNode[] }[] = [{ indent: -1, children: roots }];
  // indentation is relative to the least indented item
  const baseIndent = Math.min(
    ...lines.filter((l) => l.trim().startsWith('-')).map((l) => l.length - l.trimStart().length),
  );
  lines.forEach((rawLine, i) => {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) return;
    const indent = rawLine.length - rawLine.trimStart().length - baseIndent;
    const line = rawLine.trim();
    if (!line.startsWith('- ')) throw new Error(`aria template line ${i + 1}: expected "- role ..." but got "${line}"`);
    const body = line.slice(2);
    const node = parseTemplateLine(body, i + 1);
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    if (node.role === '/value') {
      // "- /value: text" sets the value of a node that also has children
      const parent = stack[stack.length - 1].node;
      if (parent) parent.value = node.value;
      return;
    }
    stack[stack.length - 1].children.push(node);
    stack.push({ indent, node, children: node.children });
  });
  return roots;
}

function parseTemplateLine(body: string, line: number): TemplateNode {
  // role ["name" | /re/] [attr]... [: value]
  const m = /^([\w/-]+)(?:\s+("(?:[^"\\]|\\.)*"|\/(?:[^/\\]|\\.)*\/[ims]*))?((?:\s*\[[^\]]*\])*)\s*(?::\s*(.*))?$/.exec(body);
  if (!m) throw new Error(`aria template line ${line}: cannot parse "${body}"`);
  const [, role, name, attrText, value] = m;
  const attrs = new Map<string, string>();
  for (const a of attrText.matchAll(/\[([\w-]+)(?:=([^\]]*))?\]/g)) attrs.set(a[1], a[2] ?? 'true');
  const node: TemplateNode = { role, attrs, children: [], line };
  if (role === 'text') {
    // - text: "content"
    node.name = value !== undefined && value !== '' ? parseMatcher(value) : name ? parseMatcher(name) : undefined;
    return node;
  }
  if (name) node.name = parseMatcher(name);
  if (value !== undefined && value !== '') node.value = parseMatcher(value);
  return node;
}

function nodeMatches(t: TemplateNode, n: AriaNode): boolean {
  if (t.role !== n.role) return false;
  if (!matches(t.name, n.name)) return false;
  if (t.value && !matches(t.value, n.value)) return false;
  for (const [k, v] of t.attrs) {
    const actual = (n as any)[k];
    if (k === 'level') {
      if (String(actual ?? '') !== v) return false;
    } else if (String(!!actual) !== v) {
      return false;
    }
  }
  return childrenMatch(t.children, n.children ?? []);
}

/** Every template child must match an actual child, in order (other children are allowed). */
function childrenMatch(templates: TemplateNode[], actual: AriaNode[]): boolean {
  let i = 0;
  for (const t of templates) {
    while (i < actual.length && !nodeMatches(t, actual[i])) ++i;
    if (i >= actual.length) return false;
    ++i;
  }
  return true;
}

function flatten(nodes: AriaNode[], out: AriaNode[] = []): AriaNode[] {
  for (const n of nodes) {
    out.push(n);
    flatten(n.children ?? [], out);
  }
  return out;
}

/**
 * Whether @p template matches the actual tree: the template's top-level nodes must be
 * found in document order anywhere in the tree, each with its children matching as an
 * ordered subset of the node's children (Playwright's partial matching).
 */
export function matchesAriaTemplate(template: string, actual: AriaNode[]): boolean {
  const roots = parseAriaTemplate(template);
  const all = flatten(actual);
  let i = 0;
  for (const t of roots) {
    while (i < all.length && !nodeMatches(t, all[i])) ++i;
    if (i >= all.length) return false;
    ++i;
  }
  return true;
}
