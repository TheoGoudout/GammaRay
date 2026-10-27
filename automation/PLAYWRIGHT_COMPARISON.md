# qt-playwright compared to Playwright

In short: qt-playwright covers nearly all of Playwright's API for testing a single
application. That includes the test runner integration, locators (role, label,
placeholder, title, test id, text, filters, `and`/`or`) also for item view rows,
auto-waiting and strict mode, actions, and retrying assertions (ARIA snapshots,
screenshot baselines and `toHaveCSS` included). It also has `evaluate`,
coordinate-level input, dialogs and file choosers, video, traces that Playwright's own
trace viewer opens, an inspector, and codegen. Some features are adapted rather than
identical, because Qt has no DOM, no CSS and no page JavaScript. Playwright's UI mode
and trace viewer work as they are, and `qt-playwright mcp` is the counterpart of Playwright
MCP for AI agents. What remains missing is tied to browsers (network interception, clock
control, browser contexts and storage).

Legend: ✅ same name and semantics · ≈ same idea, adapted to Qt · ❌ missing ·
➕ qt-playwright only.

## Test runner (`@playwright/test`)

| Playwright | qt-playwright | |
|---|---|---|
| `test`, `describe`, `use`, hooks, projects, workers, retries, reporters | the same, via `import { test, expect } from 'qt-playwright/test'` | ✅ |
| `page` fixture | `app` fixture (a fresh application per test) | ≈ |
| `use: { launchOptions }` | `use: { qtApp: { executable, args, env, slowMo, expectTimeout, ... } }` | ≈ |
| `use: { actionTimeout }` | honored | ✅ |
| `expect.timeout` config | `qtApp.expectTimeout` (the config value is not exposed to fixtures) | ≈ |
| `use: { screenshot }` | `qtScreenshot` (all windows attached on failure) | ≈ |
| `use: { video }` | honored (`'on'`, `'retain-on-failure'`, `'on-first-retry'`); `qtVideo` overrides | ✅ |
| `use: { trace }` | honored (all modes); Playwright's `trace.zip`, opened from the HTML report | ✅ |
| `--update-snapshots`, snapshot dirs | used by `toHaveScreenshot` | ✅ |
| API calls as report steps | yes, described like Playwright (`getByRole('button', { name: 'OK' }).click`) | ✅ |
| `expect.soft`, `expect.poll`, `expect.configure`, generic matchers | passed through to Playwright's `expect` | ✅ |
| `PWDEBUG=1`, inspector, `codegen` | `QTPW_DEBUG=1`, the inspector (web page), `qt-playwright codegen <app>` | ≈ |
| UI mode (`--ui`) | Playwright's own UI mode: run, filter, watch; actions with source lines, film strip and snapshots | ✅ |

## Launching

| Playwright | qt-playwright | |
|---|---|---|
| `launch()` + `newPage()` | `launch(executable, args, options)` returns a `QtApp` | ≈ |
| `headless`, `slowMo`, `env`, `timeout` | same names | ✅ |
| `connect()` / `connectOverCDP()`, `launchServer()` / remote browsers | `connect('host:port')`; `qt-playwright server` + `launch(app, args, { remote })` for a fresh application per test on another machine; ➕ `attach(pid)` injects into a running process | ≈ |
| browser → context → page | one `QtApp` per process; windows are found with locators (`app.windows()`) | ≈ |
| `recordVideo`, `page.video().path/saveAs/delete` | same; mp4 by default; ➕ `app.startVideo()`/`stop()`, gif, drawn pointer | ✅ |
| `selectors.setTestIdAttribute()` | `app.setTestIdAttribute(property)` (default `objectName`) | ≈ |
| `page.setViewportSize` | resize windows with `setProperty('size', { width, height })` | ≈ |
| `page.route`, request API, cookies, storage state, `context.clock`, permissions, geolocation | no Qt equivalent | ❌ |

## Page-level API (`QtApp`)

| Playwright | qt-playwright | |
|---|---|---|
| `locator`, `getByRole`, `getByLabel`, `getByPlaceholder`, `getByTitle`, `getByTestId`, `getByText` | same | ✅ |
| `getByAltText` | — (no alt text in Qt; use `getByRole('img', { name })`) | ❌ |
| `page.mouse` (`move`, `down`, `up`, `click`, `dblclick`, `wheel`) | `app.mouse`, in screen coordinates (`wheel` in Qt angle units) | ≈ |
| `page.keyboard` (`down`, `up`, `press`, `type`, `insertText`) | same | ✅ |
| `page.touchscreen.tap` | same (a real touch screen device) | ✅ |
| `page.evaluate(fn, arg)` | runs in Qt's JavaScript engine; `qApp` is the application | ≈ |
| `page.screenshot({ fullPage })` | `app.screenshot({ allWindows })` | ≈ |
| `page.on('dialog')`, `waitForEvent('dialog')`, `Dialog.accept/dismiss/message` | same, for QDialog/QMessageBox and Qt Quick dialogs | ≈ |
| `waitForEvent('filechooser')`, `FileChooser.setFiles/isMultiple` | same, for QFileDialog | ≈ |
| `page.on('close')`, `waitForEvent('close')` | same | ✅ |
| `page.on('console')` | `app.output()` (captured stdout/stderr) | ≈ |
| `page.pause()` | `app.pause()` opens the inspector (resume, step over, pick locator) | ≈ |
| `page.title()` | `app.windows()` titles, `expect(app).toHaveTitle()` | ≈ |
| `page.ariaSnapshot` | `app.ariaSnapshot()` | ✅ |
| `page.addInitScript`, `exposeFunction`, frames, workers | not applicable | ❌ |
| — | ➕ `waitForObject`, `onObjectCreated/Destroyed`, `waitForEvent('objectcreated')`, `sync()` | ➕ |

## Locators

| Playwright | qt-playwright | |
|---|---|---|
| `locator`, `first`, `last`, `nth`, `count`, `all`, `filter({ hasText, hasNotText, has, hasNot, visible })`, `and`, `or`, `describe(text)` | same | ✅ |
| `getByRole(role, { name, exact, checked, disabled, expanded, selected, pressed, level, includeHidden })` | same; roles from Qt's accessibility, with ARIA names | ✅ |
| `getByText`, `getByLabel`, `getByPlaceholder`, `getByTitle` (tooltip), `getByTestId` | same | ✅ |
| strict mode, lazy re-resolution, auto-waiting (attached, visible, stable, enabled, editable, receives events), scroll into view, `force`, `trial` | same | ✅ |
| `click`, `dblclick`, `hover`, `tap`, `fill`, `clear`, `press`, `pressSequentially`, `type`, `check`, `uncheck`, `setChecked`, `focus`, `blur`, `selectText`, `dragTo`, `scrollIntoViewIfNeeded`, `screenshot({ mask, caret })`, `waitFor` | same | ✅ |
| `selectOption` | QComboBox and QML ComboBox through their popups; item views, several options with Ctrl+click | ≈ |
| `setInputFiles` | on the button that opens a file dialog | ≈ |
| `dispatchEvent(type)` | emits a signal / calls a slot by name | ≈ |
| `evaluate`, `evaluateAll` | QObject wrappers in Qt's JS engine | ≈ |
| `textContent`, `innerText`, `inputValue`, `isVisible`, `isHidden`, `isEnabled`, `isDisabled`, `isChecked`, `isEditable`, `boundingBox`, `ariaSnapshot` | same | ✅ |
| `getAttribute(name)` | a Qt property as a string (`getProperty` for typed values) | ≈ |
| `highlight` | drawn inside the application (shows in screenshots and videos); `app.hideHighlight()` | ✅ |
| `elementHandle(s)`, `contentFrame`, `frameLocator` | — (`handle()` gives a raw element id) | ❌ |
| rows of `<ul>`, `<table>`, `<select>` | rows of QListView/QTreeView/QTableView as `listitem`/`treeitem`/`row`/`cell` elements | ≈ |
| — | ➕ `dragBy`, `spy`, `waitForSignal`, `invoke`, `setProperty`, `getProperties`, `visible()`, `selectedValues()`, `computedStyle()` | ➕ |

## Assertions

| Playwright | qt-playwright | |
|---|---|---|
| `toBeVisible`, `toBeHidden`, `toBeEnabled`, `toBeDisabled`, `toBeEditable`, `toBeChecked`, `toBeAttached`, `toBeFocused`, `toBeEmpty`, `toBeInViewport`, `toHaveText`, `toContainText` (also with arrays), `toHaveValue`, `toHaveCount`, `toHaveRole`, `toHaveAccessibleName`, `toHaveAccessibleDescription`, `toHaveId`, `toHaveJSProperty`, `toMatchAriaSnapshot`, `toHaveScreenshot`, `.not` | same | ✅ |
| `toHaveCSS` | colors (palette / style sheet / QML), fonts, opacity, size, visibility, cursor, QML borders | ≈ |
| `toHaveValues` | the selected rows of an item view | ≈ |
| `toHaveAttribute` | a Qt property compared as text | ≈ |
| `toHaveClass` | a C++ or QML type of the element | ≈ |
| `toHaveAccessibleErrorMessage` | — (no Qt equivalent) | ❌ |
| `expect(page).toHaveTitle/toHaveScreenshot` | `expect(app)`; ➕ `expect(app).toMatchAriaSnapshot` | ≈ |
| `expect(page).toHaveURL` | not applicable | ❌ |
| — | ➕ `expect(spy).toHaveBeenEmitted/Times/With`, `toHaveProperty` | ➕ |

## Selectors

| Playwright | qt-playwright | |
|---|---|---|
| `>>` chaining, `text=` (quoted, `"..."i`, regex), `nth=`, `visible=`, `internal:role=` / `has=` / `and=` / `or=` equivalents | `role=`, `label=`, `has=`, `hasNot=`, `hasText=`, `hasNotText=`, `and=`, `or=` | ✅ |
| CSS `#id`, `tag`, `[attr=value]`, `[attr*=value]` | `#objectName-or-QML-id`, C++/QML type (with base classes), `[property=value]`, `!=`, `*=`, `/regex/` | ≈ |
| CSS combinators and pseudo-classes, `xpath=` | — | ❌ |

## Tooling

| Playwright | qt-playwright | |
|---|---|---|
| Trace viewer (`trace.zip`, `show-trace`) | Playwright's own viewer: actions, call logs, errors, film strip, snapshots (screenshot + element overlay) with locator picking | ✅ |
| `codegen` | `qt-playwright codegen <app>`: role/label/test-id locators, item view rows, fill, press, check, selectOption, modifiers, drags | ✅ |
| Inspector | web inspector: live view, pick locator, locator playground with highlights, resume / step over, recording; `qt-playwright inspect <app>` | ≈ |
| UI mode | Playwright's own (`npx playwright test --ui`) | ✅ |
| VS Code extension | runs tests through `@playwright/test` like any project; untested | ≈ |

## MCP server (Playwright MCP)

| Playwright MCP | `qt-playwright mcp` | |
|---|---|---|
| stdio, `--port` (Streamable HTTP), `--host` | same; ➕ `--token` (bearer token, generated for non-loopback hosts) | ✅ |
| `browser_snapshot`: ARIA snapshot with `[ref=eN]` | `qt_snapshot`: all windows (or one element); refs are element handles, never reused | ✅ |
| `browser_click`, `browser_hover`, `browser_type` (`submit`, `slowly`), `browser_press_key`, `browser_select_option`, `browser_drag`, `browser_file_upload`, `browser_handle_dialog`, `browser_wait_for` | `qt_click`, `qt_hover`, `qt_type`, `qt_press_key`, `qt_select_option`, `qt_drag`, `qt_file_upload`, `qt_handle_dialog`, `qt_wait_for` (on refs or locator expressions) | ✅ |
| fresh snapshot and generated code in action results | same (`--no-snapshot` turns the snapshot off) | ✅ |
| `browser_take_screenshot` | `qt_screenshot`: all windows composed, or one element | ✅ |
| `browser_evaluate` | `qt_evaluate` in Qt's JavaScript engine | ≈ |
| `browser_console_messages` | the application's new stdout/stderr in every result, `qt_status` | ≈ |
| `browser_mouse_click_xy` (vision) | `qt_mouse_click_xy` in screen coordinates | ✅ |
| `browser_verify_*` (testing) | `qt_expect`: any retrying assertion, e.g. `toHaveText`, `toBeChecked`, `toHaveProperty` | ✅ |
| `browser_generate_locator` | `qt_inspect` (also types, geometry and all Qt properties), `qt_find` | ✅ |
| `browser_start_tracing` / `browser_stop_tracing` | `qt_start_tracing` / `qt_stop_tracing` (Playwright's trace.zip) | ✅ |
| `--save-video` | `qt_start_video` / `qt_stop_video` | ≈ |
| `browser_navigate`, `browser_navigate_back`, `browser_tabs`, `browser_resize`, `browser_network_requests`, `browser_pdf_save` | not applicable (windows are all in the snapshot; resize with `qt_set_property`) | ❌ |
| — | ➕ `qt_launch` (also on another machine), `qt_connect` (device port), `qt_attach` (pid), `qt_set_property`, `qt_invoke_method`, `qt_spy_signal` / `qt_signal_emissions`, `qt_highlight`, `qt_generate_test` | ➕ |

## Remaining gaps

1. Live DOM in trace snapshots: snapshots are pictures with an element overlay, so the
   viewer's DOM-specific tools (CSS inspection, console evaluation) do not apply.
