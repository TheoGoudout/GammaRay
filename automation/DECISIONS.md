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
- **Chosen:** `gammaray --inject-only --listen tcp://127.0.0.1 <app>` (default port 11732,
  with automatic fallback to a free port when it is busy). The GammaRay server stays up on
  loopback, which also keeps manual inspection possible, and the launcher lives exactly as
  long as the target.

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
  hooks, and none of them is needed. `gammaray_guisupport` appends " (Injected by
  GammaRay)" to window titles (found in the first recorded video), so it is disabled too.
  `gammaray_qmlsupport` stays enabled for QML type names.

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

## D16. Session video recording

- Options: (a) record in the probe with Qt Multimedia (`QMediaRecorder` with
  `QWindowCapture`); (b) capture frames in the probe and encode outside the
  application; (c) screen-capture the display (Xvfb + `ffmpeg -f x11grab`).
- (a) adds a heavy dependency to the injected application, and window capture backends
  don't exist on the offscreen platform. (c) needs a real X server, doesn't work
  offscreen, embedded or on remote targets, and records whatever else is on that screen.
- **Chosen: (b).** The probe composes the windows itself (`QWidget::grab`,
  `QQuickWindow::grabWindow`), which works headless and over the network. The client
  encodes with a system `ffmpeg`. Details:
   - Frames are only sent when the picture changed, as timestamped JPEGs over binary
     WebSocket messages. The client resamples them to a constant frame rate, so idle
     periods cost nothing and the video still plays back in real time.
   - The canvas size is fixed at start: encoders need constant frame sizes, and a
     stable picture is easier to watch than one that rescales whenever a window opens.
   - Window decorations and the mouse pointer are drawn by the recorder, because offscreen
     windows have neither and a test video without a pointer is hard to follow.
   - mp4/H.264 is the default rather than Playwright's webm, because it plays everywhere.
     webm, mkv, mov and gif are also available.
   - If the client falls behind (more than 64 MB buffered in the app), frames are dropped
     so a slow consumer cannot exhaust the application's memory.

## D17. Accessibility for getByRole / getByLabel / ARIA snapshots

- Options: (a) map Qt classes to roles by hand; (b) use Qt's accessibility interfaces
  (`QAccessible::queryAccessibleInterface`), which already know roles, names and
  states for Widgets and Qt Quick Controls.
- **Chosen: (b)**, with ARIA role names so Playwright users' `getByRole('button')` works
  as is. Qt Quick controls only create interfaces once accessibility is active, so it is
  activated lazily, on the first role/label query (`QAccessible::setActive(true)`).
  Apps that never use these queries see no change.
- Without a platform bridge (offscreen, CI), Qt Quick doesn't push names and states
  into its interfaces, so names fall back to `Accessible.name` (read from the attached
  object), then text, then placeholder. States fall back to the `checked`/`pressed`
  properties. A QComboBox is named after its buddy label rather than its current text,
  as browsers do, which keeps locators stable.

## D18. evaluate()

- Playwright evaluates JavaScript in the page. Qt ships a JavaScript engine, and every
  QObject can be exposed to it with its properties, slots, invokables and signals.
- **Chosen:** QML objects are evaluated by their own `QQmlEngine`, so QML values and
  types behave natively. Everything else uses a private `QJSEngine` with `qApp` bound.
  Functions travel as source text (as in Playwright), arguments and results as JSON,
  and QObjects as element references. Promises are not awaited (the engine has no
  event loop integration for that).

## D19. Dialogs, file choosers, selectOption: real UI instead of shortcuts

- Options: call slots (`QComboBox::setCurrentIndex`, `QDialog::accept`,
  `QFileDialog::selectFile`), or drive the UI as a user would.
- **Chosen: the UI path wherever practical.** `selectOption` opens the popup and clicks
  the item, so `activated` fires. `setInputFiles` types into the file dialog's name
  field and presses Enter. Widget dialogs are accepted/dismissed with Enter/Escape, so
  QMessageBox returns the right button. Qt Quick dialogs use `accept()`/`reject()`,
  which is what their buttons call.

## D20. Tracing format

- Options: (a) Playwright's `trace.zip` for `npx playwright show-trace`; (b) our own
  self-contained HTML trace viewer.
- **First (b), now (a), with (b) as an export.** The first version shipped an HTML
  viewer, because the trace format is internal and built around DOM snapshots. Writing
  it turned out to be practical. Format 10 is a JSON-lines event log (`before`,
  `after`, `input`, `log`, `screencast-frame`, `frame-snapshot`, `resource-snapshot`)
  plus resources, and the viewer upgrades older versions itself. A "DOM" snapshot can
  be a screenshot with the element tree laid over it as transparent elements carrying
  ARIA attributes. That gives Playwright's viewer, the HTML report integration and
  locator picking for free. The risk is format churn: the trace declares version 10,
  which newer viewers keep reading via their upgrade path, and `trace.spec.ts` checks
  the structure. Screenshots are network resources shared by the film strip and the
  snapshots, so each is stored once.

## D21. Codegen

- Recording happens in the probe through an application-wide event filter, so it sees
  real user input and API-synthesized input alike. That makes it testable: the codegen
  spec drives the app with the API and replays the generated code on a fresh instance.
- Mouse targets for Qt Quick come from our own hit test at the window, because the
  delivery agent sends copies of events to items. Keys come from the focus
  widget/item, typing is coalesced into one `fill()`, and combo box popups become
  `selectOption()`.
- Locators follow Playwright's preference order: role + name, label, placeholder, test
  id, QML id, text, then type. Each candidate is checked with the real selector engine
  and scoped to the window or given `.nth()` when ambiguous.

## D22. getByText default and locator descriptions

- `getByText` initially defaulted to an exact match. It now follows Playwright:
  case-insensitive substring unless `exact: true`. Raw `text="..."` selectors are
  unchanged (quoted = exact).
- Locators remember how they were built, and errors, report steps and traces show
  `getByRole('button', { name: 'Login' }).first()` rather than the internal selector.

## D23. Model/view rows as stand-in QObjects

- Options: (a) teach every layer (handles, selectors, JSON, input) a second element
  kind (view + QPersistentModelIndex); (b) one lightweight QObject per row (`ViewItem`)
  that the existing layers handle like any element.
- **Chosen: (b).** Handles, selectors, properties, describe(), ARIA snapshots and codegen
  work unchanged. The Element functions special-case ViewItem for geometry
  (`visualRect`), input (via the viewport), scrolling (`scrollTo`) and accessibility.
  Stand-ins are created under a ProbeGuard and owned by the plugin (never parented to
  the view, so the application's object tree is unchanged). They are reused while their
  QPersistentModelIndex is valid and deleted when it isn't or when the view goes away.
  Rows are created on demand when a query walks the view, capped at 5000 per parent.

## D24. toHaveCSS on Qt

- Qt has no computed CSS. `computedStyle()` maps what Qt does know to CSS names and
  browser formatting, so Playwright habits carry over. Colors come from the palette,
  which style sheets set during polish, or from QML color properties (a Rectangle's
  `color` is its background). Fonts, opacity, size, visibility and cursor map directly.
  A widget that doesn't paint its background reports `rgba(0, 0, 0, 0)`, like a
  transparent DOM element. Expected colors are normalized (`#hex`, names), because
  writing `rgb()` strings for Qt colors would be tedious.

## D25. Inspector as a web page

- Options: (a) extend the GammaRay client (Qt widgets) with Playwright's Inspector
  features; (b) a local web page served by the test process.
- **Chosen: (b).** Stepping, the locator playground and recording live in the test
  process (Node), which owns the step instrumentation and the code generator. A web
  page talks to it directly, works the same on every platform, and mirrors Playwright's
  own Inspector, which is a web UI. The live view reuses `screenshotAll` and the
  snapshot tree from tracing, and picking reuses codegen's locator choice. Deep
  inspection (object tree, properties, signals, models) stays with the GammaRay
  client, which can connect to the paused application. The server binds to 127.0.0.1
  and requires a random token in every URL, because it evaluates locator expressions.
- Highlights are drawn inside the application (a transparent overlay widget or Qt Quick
  item per window), so they work without the inspector and show in screenshots and
  videos.

## D26. Core fix: ObjectTreeModel display data

- CI showed `connectiontest-*-filter` crashing intermittently (a pre-existing race,
  reproducible on the base commit under load, with or without the automation plugin).
  The object tree's `data()` changed a row's text without `dataChanged()` in three
  cases: an object deleted in another thread before the queued row removal ran, its
  address reused by a new object in that window, and a rename. The recursive
  QSortFilterProxyModel of the object inspector search then held a stale mapping and
  crashed.
- The model now caches the display texts it reported and publishes changes only
  together with `dataChanged()`, from a queued call. This is outside the automation
  feature, but it was needed for a green CI, and it is a small, contained change to
  one model.

## D27. UI mode: reuse Playwright's

- Options: (a) reimplement a UI mode (test tree, run/watch, trace view); (b) reuse
  Playwright's.
- **Chosen: (b), no new code beyond call stacks.** UI mode is part of `@playwright/test`,
  which already runs qt-playwright tests. It turns tracing on, and the `app` fixture
  attaches Playwright-format traces (D20), so UI mode shows actions, film strip and
  snapshots. The only addition: each action records the test's call site (stack
  frames outside qt-playwright), so the Source tab highlights the line. Screenshots are
  stored as network resources (D20) and therefore show up in the Network tab, a
  cosmetic side effect.
- Live updates: UI mode sets `trace: { mode: 'on', live: true }` and, while a test runs,
  loads every trace file starting with the test id from the worker's
  `.playwright-artifacts-<worker>/traces/` directory. The fixture then writes its trace
  there too (`<testId>-qt.trace` / `.network`, screenshots in `resources/`) as events
  happen. Actions use the runner's step id as call id and the runner's clock
  (`performance.now()`), so the viewer merges each of our actions with the runner's
  step instead of listing it twice. The directory layout is Playwright-internal; if it
  changes, live updates degrade to showing the trace when the test ends.

## D28. Remote applications

- Options for tests on one machine and the application on another: (a) expose the
  automation port on the network and connect; (b) a small server on the remote machine
  that launches applications and relays the connection.
- **Both, (b) by default.** The automation server has no authentication and the
  application should be fresh for every test, which (a) can't provide. `qt-playwright
  server` reuses the local launch code, starts one application per WebSocket, and after a
  `launched` message relays text and binary messages unchanged, so everything (video,
  traces, inspector) works over it. The probe stays on 127.0.0.1. The server checks a
  bearer token (constant-time), can restrict executables (`--app`), and listens on
  127.0.0.1 unless told otherwise. Closing the socket terminates the application.
  Application output arrives as `qtpw.output` notifications, so `app.output()` works.
- (a) remains as `connect()` / `qtApp.connect` for devices without Node.js, where the
  application is started separately and shared by the tests.

## D29. MCP server for AI agents

- Goal: let an agent explore and test a running application live, also on a remote target,
  like Playwright MCP does for browsers.
- Options: (a) a new server inside the probe (C++, a second protocol in every injected
  application); (b) a Node MCP server on top of the qt-playwright client.
- **Chosen: (b), in the `qt-playwright` package** (`qt-playwright mcp`, `qt-playwright/mcp`).
  The client already has everything the tools need: launch/connect/attach, remote launching
  through `qt-playwright server` (D28), auto-waiting locators, retrying assertions, dialogs,
  tracing, video and codegen's locator choice (`locatorFor`). The remote setups therefore
  work unchanged, and the probe only gained an optional `refs` flag for `ariaSnapshot`.
- **Snapshots and refs** follow Playwright MCP: the ARIA snapshot (D17) of all windows, with
  `[ref=eN]` on each node. N is the element handle (D9), so a ref maps to the selector
  `handle=N` and gets auto-waiting for free. Handles are never reused, so a ref to a
  destroyed element fails clearly instead of hitting another element.
- **Targets** are refs or locator expressions as written in tests. The inspector evaluated
  those with `new Function`, acceptable for a local page with a token, but not for input
  from an agent or a network client. `parseLocator()` parses them instead (literals and
  locator methods only), and the inspector now uses it too.
- **Results** carry the qt-playwright code of each action, a snapshot once the UI has
  settled (two equal snapshots 100 ms apart, at most 1 s), and new application output.
  The code of actions and passing `qt_expect` assertions accumulates into
  `qt_generate_test`; refs become the locators codegen would choose.
- **SDK:** the official `@modelcontextprotocol/sdk` (stdio and Streamable HTTP) rather than a
  hand-written protocol implementation. It is a sizeable dependency (express, hono),
  but protocol negotiation and HTTP sessions are easy to get subtly wrong. It is loaded
  only by `qt-playwright/mcp`, never by tests.
- **One application per server**, shared by all MCP sessions of an HTTP server, so a
  reconnecting agent finds its application again. Files are written below `--output-dir`
  only. HTTP checks Host/Origin on loopback and requires a bearer token elsewhere.

## D30. Requests are handled outside QWebSocket's signal

- Found through the MCP server: invoking a slot that runs `QDialog::exec()` broke the
  connection. The handler ran inside `QWebSocket::textMessageReceived`, and the nested event
  loop made QWebSocket process the next frames from inside its own frame handling.
- **Chosen:** received requests are queued per connection and handled from a queued call.
  Order is unchanged, and while a handler runs a nested event loop, later requests are
  handled from that loop, as for input actions (D7). The cost is one event loop iteration
  per batch of requests.
