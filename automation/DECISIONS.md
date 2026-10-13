# Design decisions

Each entry lists the options considered and the one chosen, with the simplest viable
option preferred. Newest entries go at the bottom.

## D1. Backend: in-process probe plugin (A) vs. external client on the remote protocol (B)
- **Chosen: A.** See `ARCHITECTURE_NOTES.md` §6. Under B, the probe would need new
  server-side methods anyway, and a Node client would have to reimplement Qt's
  `QDataStream`/`QVariant` wire format.

## D2. Transport library: QtWebSockets vs. a hand-written RFC 6455 server on QTcpServer
- Options: (a) depend on Qt WebSockets, an extra Qt module, and build the plugin only
  when it is available; (b) write about 300 lines of WebSocket framing on top of
  QtNetwork.
- **Chosen: (a).** It is the simplest and best tested option. The dependency belongs to
  the optional plugin only, and GammaRay's core build is unaffected.

## D3. Event injection: QTest vs. RemoteViewServer-style postEvent
- Initial choice: QTest (`QTest::mouseClick`, `keyClick` and related functions on the
  target `QWindow`), because it goes through `QWindowSystemInterface`.
- **Revised during Phase 1:** QTest's helpers call `qApp->processEvents()` after every
  event. That re-enters the RPC dispatcher in the middle of an action and interleaves
  queued actions. **Chosen:** call the same QtGui entry points QTest uses
  (`qt_handleMouseEvent`, `qt_handleKeyEvent`, exported by QtGui) and
  `QWindowSystemInterface` for enter/leave and wheel events directly. The input is just
  as real, nothing spins the event loop, and Qt Test is not a dependency. The cost is a
  dependency on `Qt::GuiPrivate`, which GammaRay core already uses.

## D4. Location of the plugin
- Options: `plugins/automation/`, following the convention for all other probe plugins,
  or `automation/probe/` pulled in from the top-level CMake.
- **Chosen: `plugins/automation/`**, gated on `Qt::WebSockets` and `Qt::Test`. The Node
  client, examples and docs live under `automation/`.

## D5. Readiness/port discovery
- Options: fixed port; a port file; a stdout line.
- **Chosen:** default port 0 (pick a free port) plus a single stdout line
  `GammaRay automation server listening on ws://<addr>:<port>`, which the launcher
  forwards. `GAMMARAY_AUTOMATION_PORT` gives a fixed port for remote targets.
  `GAMMARAY_AUTOMATION_PORT_FILE` is available for setups without stdout access.

## D6. Launch mode
- `--no-listen` cannot be combined with `--inject-only` without either showing the
  in-process UI or hitting the launcher's 60 s safety timeout, which kills the target.
- **Chosen:** `gammaray --inject-only --listen tcp://127.0.0.1 <app>` (default port 11732, with automatic fallback to a free port when it is busy). The GammaRay
  server stays up on loopback, which also keeps manual inspection possible, and the
  launcher lives exactly as long as the target.

## D7. Executing input without blocking on nested event loops
- Problem: a click that opens a modal dialog (`QDialog::exec()`), or a drag that
  starts `QDrag::exec()`, never returns to the RPC handler.
- Options: (a) post the whole action and reply immediately; (b) run the action
  synchronously and accept the hang; (c) split the action into steps executed from a
  zero-timer, re-armed *before* each step, and reply right before the final event.
- **Chosen: (c)** (`InputQueue`). Nested event loops keep executing the remaining
  steps and serving new requests. The client still learns that the action went through,
  and state read right after `click()` already includes the effects of the click
  handler.

## D8. Opt-in activation
- The plugin is loaded into every GammaRay-injected process (metadata type `QObject`),
  including normal interactive GammaRay sessions.
- **Chosen:** the server listens only if `GAMMARAY_AUTOMATION_PORT` or the probe
  setting `AutomationPort` is set, and binds to `127.0.0.1` unless told otherwise.
  Normal GammaRay sessions are unaffected and nothing opens an unauthenticated control
  port by default.
- To enable it when attaching to a running process (whose environment can't change),
  the launcher gained a generic `--probe-setting <key>=<value>` option. This is the
  only change outside the new plugin, apart from build files.

## D9. Element handles
- **Chosen:** a monotonically increasing integer per object, backed by `QPointer`
  (plus a reverse hash for stable ids). Handles are never reused, so a destroyed object
  yields a clear "stale handle" error. Locators re-resolve on every action, so clients
  rarely hold handles across UI changes.

## D10. What "text" means and how `text=` handles composite controls
- Qt has no DOM `textContent`. **Chosen:** the first existing `text`, `plainText`,
  `currentText` or `title` property (the window title for top-level widgets). Mnemonic
  `&`s are ignored when matching.
- A QML Button and its internal contentItem/label all have the text "OK". When an
  ancestor with the same *`text` property* also matches, the descendant is dropped.
  `title` doesn't swallow descendants, so a GroupBox titled "Login" and the "Login"
  button inside it are both found.

## D11. Scrolling into view and hit testing
- Like Playwright, pointer actions first reveal the element: enclosing `Flickable`s
  get their `contentX`/`contentY` adjusted, and `QScrollArea::ensureWidgetVisible` is
  used for widgets. The adjustment is programmatic, as in browsers.
- "Receives events" check: modal blocking via `QGuiApplicationPrivate::isWindowBlocked`
  (windows), opened modal `QQuickPopup`s, `QWidget::childAt` for overlapping widgets,
  and clipping ancestors for Qt Quick items. A full Qt Quick pointer hit test that
  replicates the delivery agent was judged too complex for now (see README
  limitations).

## D12. GammaRay plugins in automation sessions
- **Chosen:** `launch()` disables all inspection tool plugins
  (`DEFAULT_DISABLED_PLUGINS`) through `GAMMARAY_DisabledPlugins`. The widget
  inspector makes modal dialogs non-modal, the signal and event monitors install global
  hooks, and none of them is needed. `gammaray_qmlsupport` stays enabled for QML type
  names.

## D13. Qt 5.15
- GammaRay 3.x requires Qt ≥ 6.5. Supporting Qt 5.15 would mean porting the probe
  plugin to the GammaRay 2.11 branch, which is not cheap. **Chosen:** Qt 6 only. The
  plugin uses Qt 6 APIs freely (`QMetaType`-based invocation, `QEnterEvent`...). The
  JSON protocol and the TypeScript client are Qt-version agnostic.

## D14. Test runner integration
- **Chosen:** `@playwright/test` fixtures (`qt-playwright/test`): an `app` fixture
  launched per test, the options `qtApp` and `qtScreenshot`, API calls reported as test
  steps, and window screenshots plus app output attached on failure. The core library
  doesn't depend on Playwright and works with any runner. The `expect` from
  `qt-playwright/test` dispatches Locators and spies to our retrying assertions and
  everything else to Playwright's `expect`. We don't override Playwright's built-in
  `toBeVisible` and similar matchers through `expect.extend`.
- Local `file:` installs must use `install-links=true`. With a symlink, the client
  resolves its own copy of `@playwright/test`, which Playwright rejects.

## D15. Default click position
- Center of the element, except for `QCheckBox`/`QRadioButton`. Those only react to
  their indicator and label (`SE_CheckBoxClickRect`), which a layout can move far from
  the center.
