# qt-playwright compared to Playwright

In short: the part of Playwright you use in everyday UI tests is closely mirrored. That
part is the test runner integration, locators with auto-waiting and strict mode,
actions, retrying `expect` assertions, timeouts, screenshots and video. If you know
Playwright, a qt-playwright test reads the same. The differences come from the target:
Qt has no DOM, no CSS, no JavaScript in the page and no network layer. Everything
built on those either has a Qt-specific replacement or is missing.

Legend: ✅ same name and semantics · ≈ same idea, different details · ❌ missing ·
➕ qt-playwright only.

## Test runner (`@playwright/test`)

| Playwright | qt-playwright | |
|---|---|---|
| `test`, `test.describe`, `test.use`, hooks, projects, parallel workers, retries, reporters | the same, via `import { test } from 'qt-playwright/test'` | ✅ |
| `page` fixture | `app` fixture (one fresh application per test) | ≈ |
| `use: { launchOptions }`, `baseURL` | `use: { qtApp: { executable, args, env, slowMo, ... } }` | ≈ |
| `use: { actionTimeout }` | honored as the default action/assertion timeout | ✅ |
| `expect.timeout` config | not read; assertions use the action timeout | ≈ |
| `use: { screenshot: 'only-on-failure' }` | `qtScreenshot` (all windows attached on failure) | ≈ |
| `use: { video: 'retain-on-failure' }` | the same option is honored; `qtVideo` overrides | ✅ |
| `use: { trace: 'on' }`, trace viewer, UI mode, `codegen`, inspector | — | ❌ |
| API calls as report steps | yes (`test.step`, boxed) | ✅ |
| `expect.soft`, `expect.poll`, `expect.configure`, generic matchers | passed through to Playwright's `expect` | ✅ |

## Launching and pages

| Playwright | qt-playwright | |
|---|---|---|
| `chromium.launch()` + `browser.newPage()` | `launch(executable, args, options)` returns a `QtApp` | ≈ |
| `connectOverCDP(url)` / `connect(wsEndpoint)` | `attach('host:port')`; ➕ `attach(pid)` injects into a running process | ≈ |
| `headless`, `slowMo`, `env`, `timeout` | same names | ✅ |
| Browser → context → page hierarchy | one `QtApp` per process; its windows are found with locators (`app.windows()`) | ≈ |
| `page.close()` / `browser.close()` | `app.close()` (terminates launched apps, detaches from attached ones) | ≈ |
| `page.screenshot({ path })` | `app.screenshot({ path })` (focused window), `app.screenshotAllWindows()` | ≈ |
| `recordVideo: { dir, size }`, `page.video().path() / saveAs() / delete()` | same; mp4 by default instead of webm | ✅ |
| — | ➕ `app.startVideo(path)` / `video.stop()` for on-demand recordings, gif output, pointer and title bars drawn | ➕ |
| `page.keyboard.press/type` | `app.press(key)`, `app.type(text)` (to the focused window) | ≈ |
| `page.keyboard.down/up`, `page.mouse.move/down/up/wheel(x, y)` (coordinate-level input) | — | ❌ |
| `page.evaluate(fn)` | `locator.invoke(method, ...args)`, `getProperty`, `setProperty` (no arbitrary code) | ≈ |
| `page.on('dialog')`, `on('filechooser')`, `on('download')` | Qt dialogs are ordinary windows: use locators | ≈ |
| `page.on('console')` | `app.output()` (captured stdout/stderr) | ≈ |
| `page.route`, network interception, `request` API, cookies, storage state | not applicable | ❌ |
| `page.waitForEvent` | ➕ `waitForSignal`, `spy`, `app.waitForObject`, `onObjectCreated/Destroyed` | ≈ |

## Locators

| Playwright | qt-playwright | |
|---|---|---|
| `page.locator(selector)`, `locator.locator()` | same | ✅ |
| `first()`, `last()`, `nth(i)`, `count()`, `all()` | same | ✅ |
| Strict mode, lazy re-resolution, auto-waiting | same rules: attached, visible, stable, enabled, receives events, and scroll into view before pointer actions | ✅ |
| `getByText(text, { exact })` | same; text is the element's own `text`/`title`/... property, not the DOM's concatenated `textContent` | ≈ |
| `getByRole`, `getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`, `getByTestId` | — (use `[placeholderText="..."]`, `#objectName`, types) | ❌ |
| `filter({ hasText, has, hasNot })`, `and()`, `or()` | — (use `>>`, `[prop]` filters, `visible=true`) | ❌ |
| `click`, `dblclick`, `hover`, `fill`, `clear`, `press`, `pressSequentially`, `type`, `check`, `uncheck`, `setChecked`, `focus`, `dragTo`, `scrollIntoViewIfNeeded`, `screenshot`, `waitFor` | same names and options (`button`, `modifiers`, `position`, `clickCount`, `force`, `timeout`, `sourcePosition`, `targetPosition`, `steps`) | ✅ |
| `selectOption`, `setInputFiles`, `tap`, `dispatchEvent`, `blur`, `highlight`, `selectText` | — | ❌ |
| `textContent`, `innerText`, `inputValue`, `isVisible`, `isHidden`, `isEnabled`, `isDisabled`, `isChecked`, `boundingBox` | same | ✅ |
| `getAttribute`, `evaluate`, `evaluateAll`, `elementHandle` | `getProperty`, `getProperties`, `invoke`, `describe`, `handle()` | ≈ |
| `locator.scroll...` / `mouse.wheel(dx, dy)` in pixels | `locator.scroll({ deltaX, deltaY })` in Qt wheel units (120 = one notch) | ≈ |
| — | ➕ `dragBy(dx, dy)`, `spy(signal)`, `waitForSignal(signal)`, `visible()` | ➕ |

## Selectors

| Playwright | qt-playwright | |
|---|---|---|
| `>>` chaining, `text=...` (quoted exact, bare substring, `/regex/`), `nth=`, `visible=` | same syntax and semantics (Playwright's classic selector engine) | ✅ |
| CSS: `#id`, `tag`, `[attr=value]`, `[attr*=value]` | `#objectName-or-QML-id`, C++/QML **type** (base classes match too), `[property=value]`, `[property*=value]`, `[property!=value]`, `[property=/re/]` | ≈ |
| CSS combinators (descendant, `>`, `+`, `~`), pseudo-classes (`:has()`, `:visible`, `:text()`), `xpath=`, `internal:role=` | — | ❌ |

## Assertions

| Playwright | qt-playwright | |
|---|---|---|
| `toBeVisible`, `toBeHidden`, `toBeEnabled`, `toBeDisabled`, `toBeChecked`, `toBeAttached`, `toBeFocused`, `toHaveText`, `toContainText`, `toHaveValue`, `toHaveCount`, `.not` | same, retrying | ✅ |
| `toHaveJSProperty(name, value)` | `toHaveProperty(name, value)` (Qt property) | ≈ |
| `toHaveAttribute`, `toHaveClass`, `toHaveCSS`, `toHaveId`, `toBeEditable`, `toBeEmpty`, `toBeInViewport`, `toHaveAccessibleName/Role/Description`, `toHaveValues` | — | ❌ |
| `toHaveScreenshot` (visual comparison with baselines) | — (screenshots exist; no diffing yet) | ❌ |
| — | ➕ `expect(spy).toHaveBeenEmitted()`, `toHaveBeenEmittedTimes(n)`, `toHaveBeenEmittedWith(args)` | ➕ |

## Qt-specific extras

- Properties and methods: `getProperty`, `setProperty` (enums by name, colors, geometry
  types), `getProperties`, and `invoke` for slots, `Q_INVOKABLE`s and QML functions.
- Signals: `waitForSignal`, `spy` and the spy assertions.
- Object lifecycle: `app.waitForObject(selector)`, `onObjectCreated`,
  `onObjectDestroyed`.
- QML and C++ type selectors with inheritance, QML ids, the visual item tree and
  popup contents.
- Injection into already running processes (`attach(pid)`) and remote/embedded targets
  (`attach('device:port')`), all through GammaRay's injectors.
- Hit testing that understands Qt modality: modal windows, modal Qt Quick popups and
  clipped Qt Quick items.
- Video: one file showing all windows, with a drawn pointer, gif/mp4/webm output, and
  on-demand start/stop.
- `app.sync()` to wait for queued input to be delivered.

## Most valuable next steps toward parity

1. `getByRole`, `getByLabel` and `toHaveAccessibleName`, implemented on top of
   `QAccessibleInterface`. Qt exposes roles and names for both Widgets and Qt Quick
   controls.
2. `locator.filter({ hasText, has })`, `and()` and `or()`, which compose cleanly with
   the existing engine.
3. `toHaveScreenshot` with baseline images and pixel diffing.
4. A trace (action log with before/after screenshots per step), readable by Playwright's
   trace viewer or a simple HTML report.
5. Coordinate-level `mouse`/`keyboard` objects (`mouse.move/down/up`,
   `keyboard.down/up`).
6. `selectOption` for `QComboBox` / QML `ComboBox`.
