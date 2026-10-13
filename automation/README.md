# qt-playwright: Playwright-style end-to-end tests for Qt apps

`qt-playwright` drives Qt applications (QtWidgets and Qt Quick/QML) from TypeScript tests
in the style of [Playwright](https://playwright.dev): lazy locators, auto-waiting
actions, retrying assertions and `@playwright/test` fixtures. Under the hood it uses
**GammaRay**: the GammaRay launcher injects the probe into the application, and a new
probe plugin (`gammaray_automation`) serves a JSON-RPC API over WebSocket from inside
the process.

```
 test (Node)                            application process
 ┌───────────────────────┐   ws://     ┌───────────────────────────────────────────┐
 │ qt-playwright         │◄──────────► │ GammaRay probe                            │
 │  launch()/attach()    │  JSON-RPC   │  └ gammaray_automation plugin             │
 │  Locator, expect()    │             │      selector engine, handles, input,     │
 └──────────┬────────────┘             │      signals, screenshots (GUI thread)    │
            │ spawns                   └───────────────────────────────────────────┘
            ▼                                   ▲ LD_PRELOAD / gdb / ...
   gammaray --inject-only ... ./app ────────────┘
```

| Path | What |
|------|------|
| `plugins/automation/` | probe plugin (C++, built with GammaRay when Qt WebSockets is available) |
| `automation/client/` | the `qt-playwright` npm package (TypeScript) |
| `automation/examples/sampleapp/` | sample app with a Widgets and a QML window (login form, list, dialog...) |
| `automation/examples/tests/` | example suite exercising every API feature |
| `automation/run-e2e.sh` | builds everything and runs the suite headless |
| `ARCHITECTURE_NOTES.md`, `DECISIONS.md` | design background |

## Setup

Requirements: Qt ≥ 6.5 **with the Qt WebSockets module** (GammaRay 3.x is Qt 6 only),
CMake, a C++17 compiler, Node.js ≥ 18. On Linux, `gdb` is only needed to attach to
already running processes.

1. **Build GammaRay** as usual. If Qt WebSockets is found, the automation plugin is
   built automatically (`-- WARNING: Skipping the automation plugin ...` otherwise):

   ```sh
   cmake -S . -B build -G Ninja -DCMAKE_PREFIX_PATH=/path/to/Qt/6.8.3/gcc_64
   cmake --build build            # optionally: cmake --install build
   ```

2. **Install the client** into your test project. It is not published to npm yet, so
   install it from a checkout:

   ```sh
   cd automation/client && npm ci            # also builds dist/
   cd my-tests && npm install -D @playwright/test /path/to/GammaRay/automation/client
   ```

   Use `install-links=true` in your project's `.npmrc` (as `automation/examples` does).
   This copies the package instead of symlinking it, so it shares your
   `@playwright/test` instead of loading a second one.

3. **Point it at the launcher**: put `gammaray` on the `PATH`, or set
   `QT_PLAYWRIGHT_GAMMARAY=/path/to/build/bin/gammaray` (or pass `gammaray:` in the
   launch options).

To run the bundled example suite in one go (headless):

```sh
QT_PREFIX=/path/to/Qt/6.8.3/gcc_64 automation/run-e2e.sh
```

### Headless / CI

With no `DISPLAY` or `WAYLAND_DISPLAY`, or with `headless: true`, `launch()` sets
`QT_QPA_PLATFORM=offscreen` and `QT_QUICK_BACKEND=software` for both the GammaRay
launcher (itself a Qt GUI application) and the app. No X server or GPU is needed, and
screenshots still work. See `.github/workflows/automation.yml` for a complete CI job.

## A complete example

`playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';
import type { QtOptions } from 'qt-playwright/test';

export default defineConfig<QtOptions>({
  testDir: './tests',
  fullyParallel: true, // every test gets its own app instance and port
  use: {
    qtApp: { executable: './build/myapp', args: [], env: { MYAPP_CONFIG: 'test' } },
    qtScreenshot: 'only-on-failure', // window screenshots attached to failed tests
    actionTimeout: 5_000, // default timeout for actions and assertions
  },
});
```

`tests/login.spec.ts`:

```ts
import { expect, test } from 'qt-playwright/test';

test('user can log in', async ({ app }) => {
  const window = app.locator('#loginWindow'); // objectName or QML id
  const login = window.locator('Button#loginButton'); // QML type + id

  await expect(login).toBeDisabled();
  await window.locator('#username').fill('admin'); // real key events
  await window.locator('#password').fill('secret');
  await expect(login).toBeEnabled(); // retried until true or timeout

  const loggedIn = await window.spy('loggedIn'); // record a signal
  await login.click(); // waits: visible, enabled, stable, not covered

  await expect(window.locator('#status')).toHaveText('Welcome, admin!');
  await expect(loggedIn).toHaveBeenEmittedWith(['admin']);
  await expect(window).toHaveProperty('loginAttempts', 1);

  // a modal dialog runs a nested event loop; the app stays scriptable
  await window.getByText('Delete account').click();
  const dialog = app.locator('#confirmDialog');
  await expect(dialog).toBeVisible();
  await dialog.getByText('Cancel').click();
  await expect(dialog).toBeHidden();
});
```

Run it with `npx playwright test`. The `app` fixture launches the application under
GammaRay for each test and terminates it afterwards. When a test fails, a screenshot
of every window and the app's stdout/stderr are attached to the report.

Without the test runner (e.g. with Vitest or a plain script):

```ts
import { expect, launch } from 'qt-playwright';

const app = await launch('./build/myapp', ['--some-flag']);
try {
  await app.locator('#okButton').click();
  await expect(app.locator('#status')).toHaveText('Done');
} finally {
  await app.close();
}
```

## Selectors

Selectors are matched against the combined tree of `QObject` children and the Qt Quick
**visual** tree (`QQuickItem::childItems()`, `QQuickWindow::contentItem()`, popup
contents). Results are in document order.

| Selector | Matches |
|----------|---------|
| `#okButton` | `objectName` **or** QML `id` |
| `QPushButton`, `QAbstractButton` | C++ class, including base classes |
| `Button`, `TextField`, `Item`, `Main` | QML type: Qt Quick classes without the `QQuick` prefix, QML-defined types by name |
| `*` | anything |
| `text="Save"` | text equals "Save" (case-sensitive, whitespace-normalized, `&` mnemonics ignored) |
| `text=save` | text contains "save", case-insensitive |
| `text=/^Sa.e$/i` | regular expression (flags `i`, `s`, `m`) |
| `[checked=true]`, `[echoMode=Password]` | property equals (enums by key name, numbers numerically) |
| `[text!="x"]`, `[text*="Rem"]`, `[text=/re/]` | not-equals, contains, regex |
| `[checked]` | property is truthy |
| `A >> B` | `B` among the descendants of matches of `A` |
| `nth=1`, `nth=-1`, `first`, `last` | pick one of the matches so far |
| `visible=true` / `visible=false` | keep only (in)visible matches |

Segments combine: `#loginBox >> QLineEdit[echoMode=Password]`,
`QPushButton#ok[enabled=true]`. Quote values containing `]` or starting with `/`.
"Text" is the first of the `text`, `plainText`, `currentText` and `title` properties
that exists (the window title for top-level widgets). A control's own text wins over
the internal items that render it, so `text="OK"` finds the Button, not its Label
child.

**Strict mode:** actions and single-element queries throw `StrictModeViolationError`
when a locator matches more than one element. The message lists the matches. Use a
more specific selector, scope with `>>`, or use `.first()`, `.last()` or `.nth(i)`.

## API overview

### Launching and connecting

| | |
|-|-|
| `launch(app, args?, options?)` | start under `gammaray --inject-only` with the automation server enabled; options: `env`, `cwd`, `headless`, `gammaray`, `timeout`, `probeAbi`, `injector`, `automationPort`, `disabledPlugins`, `printOutput`, `defaultTimeout` |
| `attach("host:port" \| "ws://...")` | connect to a running automation server, e.g. on a remote/embedded device |
| `attach(pid)` | inject the probe into a running process (gdb/lldb) and enable automation in it |
| `app.close()` | disconnect; for launched apps also terminate them |
| `app.locator(sel)`, `app.getByText(t)`, `app.getById(id)` | locators |
| `app.windows()`, `app.screenshot()`, `app.screenshotAllWindows()` | windows |
| `app.press(key)`, `app.type(text)` | keyboard input to the focused window |
| `app.waitForObject(sel)`, `app.onObjectCreated(cb)`, `app.onObjectDestroyed(cb)` | object lifecycle events |
| `app.setDefaultTimeout(ms)`, `app.pid`, `app.info`, `app.output()` | misc |

Remote or embedded targets: start the app on the device with
`GAMMARAY_AUTOMATION_PORT=<port> GAMMARAY_AUTOMATION_ADDRESS=0.0.0.0 gammaray --inject-only ./app`
(or set the variables and preload the probe yourself), then `attach("device:<port>")`.

### Locators

All actions **auto-wait** until the element exists, is unique, is visible, is enabled
(where it matters) and is stable. Pointer actions also wait until the element receives
pointer events, i.e. it is not blocked by a modal window or popup, covered by another
widget, or clipped away. Before pointer actions, enclosing Flickables, ListViews and
QScrollAreas are scrolled to reveal the element. Pass `force: true` to skip the checks
and `timeout` to override the default.

| Actions | Queries | Composition |
|-|-|-|
| `click({button, modifiers, position, clickCount})` | `getProperty(name)`, `getProperties()` | `locator(sel)` |
| `dblclick()`, `hover()` | `setProperty(name, value)` | `getByText(text, {exact})` |
| `fill(text)`, `clear()` | `invoke(method, ...args)` | `first()`, `last()`, `nth(i)` |
| `pressSequentially(text)` / `type(text)` | `textContent()`, `inputValue()` | `visible()` |
| `press("Control+A")` | `isVisible()`, `isHidden()`, `isEnabled()`, `isChecked()` | `count()`, `all()`, `elements()` |
| `check()`, `uncheck()`, `setChecked(b)` | `boundingBox()`, `describe()` | `handle()` |
| `scroll({deltaX, deltaY})` (120 = one wheel notch) | `screenshot({path, window})` | |
| `dragTo(locator)`, `dragBy(dx, dy)` | `waitFor({state})` | |
| `focus()`, `scrollIntoViewIfNeeded()` | `waitForSignal(sig)`, `spy(sig)` | |

Input is real input. Events go through QtGui's window system interface, the same path
as platform input and QTest. Hit testing, modality, focus changes, enter/leave, hover
handlers, double-click detection and drag thresholds behave as for a user. Keys use
Playwright names: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `ArrowUp`, `Home`,
`PageDown`, `F1`–`F35`, `Space`, single characters, with `Shift+`, `Control+`, `Alt+`,
`Meta+` (`ControlOrMeta+` maps to `Control`, which is Cmd on macOS).

Property values are converted to JSON: enums become key names, colors become
`"#rrggbb"`, `QPoint`/`QSize`/`QRect` become `{x, y, width, height}`, `QObject*` becomes
`{handle, type, ...}`. Writing accepts the same forms. `invoke` works for slots,
`Q_INVOKABLE`s and QML functions; pass `{ handle }` for QObject arguments.

### Signals

```ts
const spy = await window.spy('loggedIn');                // or 'loggedIn(QString)'
await loginButton.click();
expect(await spy.wait()).toEqual(['admin']);             // next emission's arguments
await expect(spy).toHaveBeenEmittedTimes(1);

const [args] = await Promise.all([window.waitForSignal('loggedIn'), loginButton.click()]);
```

Requests reach the application in order, so a `waitForSignal` sent before an action is
armed before the action's input is delivered.

### Assertions

`expect(locator)` from `qt-playwright/test` (or `qt-playwright`) retries until the
assertion passes or the timeout expires. All assertions support `.not`:
`toBeVisible`, `toBeHidden`, `toBeEnabled`, `toBeDisabled`, `toBeChecked({checked})`,
`toBeAttached`, `toBeFocused`, `toHaveText(str|re)`, `toContainText`, `toHaveValue`,
`toHaveProperty(name, value)`, `toHaveCount(n)`. For spies: `toHaveBeenEmitted`,
`toHaveBeenEmittedTimes(n)`, `toHaveBeenEmittedWith(args)`. The `expect` exported by
`qt-playwright/test` passes any other value to Playwright's own `expect`. The one from
`qt-playwright` only accepts Locators and spies.

## Protocol

The plugin speaks JSON-RPC 2.0 over WebSocket. Any language can drive it. It is
**opt-in**: it only listens if `GAMMARAY_AUTOMATION_PORT` (or the probe setting
`AutomationPort`, e.g. `gammaray --probe-setting AutomationPort=0`) is set; `0` picks a
free port. It binds to `127.0.0.1` unless `GAMMARAY_AUTOMATION_ADDRESS` says otherwise.
When ready it prints `GammaRay automation server listening on ws://...` and writes
`$TMPDIR/gammaray-automation-<pid>.json` (or `$GAMMARAY_AUTOMATION_PORT_FILE`).

Methods: `hello`, `query {selector, scope?, describe?}`, `windows`, `describe`,
`actionability`, `scrollIntoView`, `getProperty`, `getProperties`, `setProperty`,
`invokeMethod`, `isVisible`, `isEnabled`, `text`, `geometry`, `focus`, `click`,
`doubleClick`, `hover`, `type`, `fill`, `press`, `scroll`, `drag`, `sync`,
`screenshot`, `waitForSignal`, `spy`, `spyEvents`, `unspy`, `subscribe`. Notifications:
`objectsCreated {elements}`, `objectsDestroyed {handles}`. Elements are referred to by
stable integer **handles**, which are never reused. A handle to a destroyed object
fails with error `1001` (stale). See `plugins/automation/automation.cpp` for the
parameters.

Everything runs on the GUI thread. Input actions run as small steps from a zero-timer
and reply before the final event (for example the mouse release). An action that opens
a modal dialog (`QDialog::exec()`) or starts a drag therefore doesn't block the API:
later requests are served from the nested event loop.

## Limitations

- **Model/view rows are not elements.** Rows and cells of `QListView`, `QTableView` and
  `QTreeView` and similar views are not QObjects. Address them by `position` inside the
  view's viewport, or through properties and slots (`currentRow`, `setCurrentIndex`...).
  QML delegates *are* items and work normally, but only once instantiated (off-screen
  ListView delegates may not exist yet).
- **Text** is an element's own text property, not the concatenated text of its
  descendants as in the DOM.
- **QML type names** come from class names (`QQuickButton` gives `Button`,
  `LoginForm_QMLTYPE_3` gives `LoginForm`). Module-qualified names
  (`QtQuick.Controls/Button`) only work for C++-registered types, and only when
  GammaRay's qmlsupport plugin is loaded. Types are matched along the C++ class chain,
  so a QML component inherits matches from its C++ base (`Button` →
  `AbstractButton` → `Control` → `Item`), not from intermediate QML-defined bases.
- **Obstruction checks** detect modal windows, modal Qt Quick popups, overlapping
  widgets and clipping ancestors of Qt Quick items. A Qt Quick item covered by an
  unrelated sibling (for example a MouseArea on top) is not detected.
- **Not covered:** QGraphicsView items, Qt 3D, Qt WebEngine content, native platform
  dialogs and menus. QQuickWidget content is supported but less tested. Widget drag and
  drop through `QDrag` is untested.
- `invoke()` is synchronous: invoking something that runs `exec()` only returns when
  the dialog closes. Click the button that opens it instead.
- **Platforms:** developed and tested on Linux with Qt 6.8 and the offscreen platform.
  Launching should work wherever GammaRay injection works (Windows `windll`, macOS
  preload) but is untested. Attaching by pid needs gdb or lldb and ptrace permission.
- **Qt 5 is not supported**, because GammaRay 3.x itself requires Qt ≥ 6.5. The
  client and protocol are Qt-version agnostic.
- **Security:** the automation server is unauthenticated and can fully control the
  application. It is opt-in and binds to localhost by default. Only expose it (with
  `GAMMARAY_AUTOMATION_ADDRESS`) on trusted networks.
- Synthetic input coexists with real input: on a real desktop, moving the physical
  mouse during a test can interfere.
