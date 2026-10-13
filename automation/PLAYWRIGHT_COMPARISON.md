# qt-playwright compared to Playwright

In short: qt-playwright covers nearly all of Playwright's API for testing a single
application. That includes the test runner integration, locators (role, label,
placeholder, title, test id, text, filters, `and`/`or`), auto-waiting and strict mode,
actions, retrying assertions (ARIA snapshots and screenshot baselines included),
`evaluate`, coordinate-level input, dialogs and file choosers, video, tracing and
codegen. Some features are adapted rather than identical, because Qt has no DOM, no CSS
and no page JavaScript. What remains missing is tied to browsers: network interception,
clock control, browser contexts and storage, and Playwright's own trace viewer and UI
mode.

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
| `use: { trace }` | honored (all modes); the trace is an HTML viewer instead of `trace.zip` | ≈ |
| `--update-snapshots`, snapshot dirs | used by `toHaveScreenshot` | ✅ |
| API calls as report steps | yes, described like Playwright (`getByRole('button', { name: 'OK' }).click`) | ✅ |
| `expect.soft`, `expect.poll`, `expect.configure`, generic matchers | passed through to Playwright's `expect` | ✅ |
| UI mode, inspector, `codegen` | `qt-playwright codegen <app>` and `app.pause()`; no UI mode or inspector | ≈ |

## Launching

| Playwright | qt-playwright | |
|---|---|---|
| `launch()` + `newPage()` | `launch(executable, args, options)` returns a `QtApp` | ≈ |
| `headless`, `slowMo`, `env`, `timeout` | same names | ✅ |
| `connect()` / `connectOverCDP()` | `attach('host:port')`; ➕ `attach(pid)` injects into a running process | ≈ |
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
| `page.pause()` | `app.pause()` (waits for Enter; inspect with the GammaRay client) | ≈ |
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
| `selectOption` | QComboBox and QML ComboBox, through their popups; one option at a time | ≈ |
| `setInputFiles` | on the button that opens a file dialog | ≈ |
| `dispatchEvent(type)` | emits a signal / calls a slot by name | ≈ |
| `evaluate`, `evaluateAll` | QObject wrappers in Qt's JS engine | ≈ |
| `textContent`, `innerText`, `inputValue`, `isVisible`, `isHidden`, `isEnabled`, `isDisabled`, `isChecked`, `isEditable`, `boundingBox`, `ariaSnapshot` | same | ✅ |
| `getAttribute(name)` | a Qt property as a string (`getProperty` for typed values) | ≈ |
| `highlight`, `elementHandle(s)`, `contentFrame`, `frameLocator` | — (`handle()` gives a raw element id) | ❌ |
| — | ➕ `dragBy`, `spy`, `waitForSignal`, `invoke`, `setProperty`, `getProperties`, `visible()` | ➕ |

## Assertions

| Playwright | qt-playwright | |
|---|---|---|
| `toBeVisible`, `toBeHidden`, `toBeEnabled`, `toBeDisabled`, `toBeEditable`, `toBeChecked`, `toBeAttached`, `toBeFocused`, `toBeEmpty`, `toBeInViewport`, `toHaveText`, `toContainText`, `toHaveValue`, `toHaveCount`, `toHaveRole`, `toHaveAccessibleName`, `toHaveAccessibleDescription`, `toHaveId`, `toHaveJSProperty`, `toMatchAriaSnapshot`, `toHaveScreenshot`, `.not` | same | ✅ |
| `toHaveAttribute` | a Qt property compared as text | ≈ |
| `toHaveClass` | a C++ or QML type of the element | ≈ |
| `toHaveCSS`, `toHaveValues`, `toHaveAccessibleErrorMessage` | — | ❌ |
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
| Trace viewer (`trace.zip`, `show-trace`) | self-contained HTML trace: actions, timing, errors, screenshots | ≈ |
| `codegen` | `qt-playwright codegen <app>`: role/label/test-id locators, fill, press, check, selectOption, drags | ✅ |
| Inspector, UI mode, VS Code extension | — (use the GammaRay client to inspect a running app) | ❌ |

## Remaining gaps worth closing

1. Playwright's own trace format, so `npx playwright show-trace` works. This needs DOM
   snapshots, or at least screencast frames in its format.
2. `toHaveCSS` for Qt style sheets / palettes, and `toHaveValues` for multi-selection
   views.
3. Model/view rows as elements (QListView, QTableView), via
   `QAbstractItemView::visualRect`, so rows can be located, clicked and recorded by
   codegen.
4. An inspector UI, which could build on GammaRay's existing client.
