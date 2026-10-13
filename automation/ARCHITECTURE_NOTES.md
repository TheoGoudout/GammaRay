# GammaRay internals relevant to `qt-playwright` (Phase 0 notes)

These notes record what I learned reading the GammaRay 3.4 sources before building an
end-to-end test framework on top of it. File references are relative to the repo root.

## 0. Baseline facts

- **Qt version.** GammaRay 3.x is **Qt 6 only** and needs Qt ≥ 6.5 (`CMakeLists.txt:440`
  fails hard below that). Qt 5.15 support was dropped upstream, so "keep Qt 5.15
  compatibility where cheap" can only apply to the new plugin's own source (plain
  `QT_VERSION` guards). It cannot apply to the build, because core GammaRay no longer
  builds against Qt 5.
- **Dev environment used here.** Ubuntu 24.04 only ships Qt 6.4.2, which is too old. I
  installed Qt 6.8.3 LTS (`linux_gcc_64`, plus `qtwebsockets`) with `aqtinstall` into
  `/opt/Qt/6.8.3/gcc_64`. GammaRay configures and builds against it with
  `-DCMAKE_PREFIX_PATH=/opt/Qt/6.8.3/gcc_64`.
- **Optional modules.** Qt WebSockets is *not* a GammaRay dependency today. Qt Test is
  already an optional `find_package` component (`CMakeLists.txt:461`).

## 1. Injection

### 1.1 Launcher (`launcher/`)

- `launcher/cli/main.cpp` is the `gammaray` executable. It parses options into
  `LaunchOptions` (`launcher/core/launchoptions.*`), detects the target ABI
  (`ProbeABIDetector`), and picks a probe (`ProbeFinder`, which looks up
  `lib/gammaray/<ver>/<abi>/gammaray_probe.so`). It then runs `Launcher::start()`.
- `Launcher` (`launcher/core/launcher.cpp`):
  1. Opens a `QLocalServer` named `gammaray-<launcher pid or target pid>`. The probe
     connects to it to fetch its **probe settings** (a `QHash<QByteArray,QByteArray>`)
     and to report back the GammaRay server address (`Protocol::ServerAddress`) or a
     launch error.
  2. Creates an injector through `InjectorFactory`, then calls `launch()` (new process)
     or `attach()` (existing pid).
  3. When the probe reports its address, it prints `GammaRay server listening on: …`. In
     `OutOfProcessUi` mode it also spawns `gammaray-client`.
  4. In **launch** mode the launcher stays alive as the target's parent (stdout/stderr
     are forwarded) and exits with the target's exit code. `~Launcher` calls
     `injector->stop()`, which kills the target. In **attach** mode it exits as soon as
     the probe reports its address.
  5. A safety timer (60 s, or `GAMMARAY_LAUNCHER_TIMEOUT`) runs unless the UI mode is
     in-process. If no server address arrives before it fires, the launcher treats the
     launch as failed, exits, and so kills the target.
- **Injectors** (`launcher/core/injector/`):
  - `preload` is the default for launch on Linux and macOS. It sets
    `LD_PRELOAD`/`DYLD_INSERT_LIBRARIES` to the probe and `GAMMARAY_UNSET_PRELOAD=1`, so
    child processes don't inherit it. ASAN libraries are put first.
  - `gdb` and `lldb` are used for attach. They break into the process and `dlopen` the
    probe, then call `gammaray_probe_attach()`. Attaching needs gdb/lldb and ptrace
    permission (`/proc/sys/kernel/yama/ptrace_scope`).
  - `windll` (Windows, CreateRemoteThread), `style` (injects through the
    `-style gammaray-injector` Qt style plugin, which works without preload or debugger
    support) and `process` (the target is already linked against the probe).
- **CLI modes that matter for headless use:**
  - `--inject-only` gives `UiMode::NoUi`: no client is started, but the probe's TCP
    server still listens (`RemoteAccessEnabled` defaults to true).
  - `--no-listen` sets `RemoteAccessEnabled=false` **and forces `InProcessUi`**. The two
    flags are order-sensitive: `--inject-only --no-listen` ends up in in-process UI mode
    and tries to show GammaRay's main window. `--no-listen --inject-only` gives NoUi
    without a server, **but** then the probe never sends a server address, the
    launcher's safety timer fires after 60 s, and the launcher exits and kills the
    target. **Conclusion: in automation mode, use `--inject-only --listen tcp://127.0.0.1`
    and do not use `--no-listen`.** Our own server has to report its readiness on its own
    channel (see §5).
  - `--listen <url>` sets the probe's `ServerAddress`. `TcpServerDevice::listen()` falls
    back to a random port if the requested one is busy, so parallel targets work.
  - `-p/--pid <pid>` attaches. `--connect host:port` only starts the GUI client against
    an already-running probe.
  - `--probe <abi>` and `--list-probes` override the ABI.
- **Without a launcher.** `ProbeSettings::value(key)` (`core/probesettings.cpp`) falls
  back to the environment variable `GAMMARAY_<key>` when the launcher didn't provide the
  key. If no launcher local server exists, the probe connects, fails immediately and
  continues with env-only settings. So
  `LD_PRELOAD=…/gammaray_probe.so GAMMARAY_ProbePath=… GAMMARAY_RemoteAccessEnabled=0 ./app`
  is a fully launcher-less, headless injection. `tests/baseprobetest.h` does the same
  thing in-process.
- **Remote and embedded targets:**
  - The probe's server listens on `tcp://0.0.0.0:11732` by default and broadcasts UDP
    discovery on port 13325 every 5 s (`core/remote/server.cpp`). Remote targets are
    started on the device with `gammaray --inject-only --listen tcp://0.0.0.0:<port>`
    (or with the env-var form) and reached over the network.
  - `GAMMARAY_STATIC_PROBE` (`core/staticprobe.h`) links the probe and plugins statically
    for iOS and some embedded setups. The app adds `GAMMARAY_STATIC_INJECT` in
    `main.cpp`, and plugins are pulled in with `Q_IMPORT_PLUGIN`. An automation plugin
    would need one more `Q_IMPORT_PLUGIN` line there.
  - On Android, settings come from `<meta-data android:name="com.kdab.gammaray.<key>">`.

### 1.2 Probe startup (`probe/`, `core/probe.cpp`)

1. A static initializer in `probe/entry_unix.cpp` installs `Hooks::installHooks()`.
   These are Qt's `qtHookData` callbacks: `AddQObject`, `RemoveQObject` and `Startup`,
   chained to any previous hooks. `Q_COREAPP_STARTUP_FUNCTION` and the startup hook
   create a `ProbeCreator`.
2. `ProbeCreator` moves itself to the main thread and queues `createProbe()`. After that,
   everything happens on the **GUI thread** once the event loop runs.
3. `Probe::createProbe()` creates the `Probe` singleton, replays objects seen before it
   existed, and optionally runs `findExistingObjects()` (used for attach), which walks
   `qApp` and `allWindows()`. It then queues `delayedInit()`.
4. `delayedInit()` installs the probe as an application-wide event filter, starts the
   `Server` (`listen()`), reports the address to the launcher, and optionally shows the
   in-process UI.
5. The `ToolManager` (created in the `Probe` constructor) registers built-in tools and all
   plugin `ToolFactory`s. They stay **disabled** until an object whose class (or a base
   class) is listed in the plugin's `types` metadata shows up. At that point
   `factory->init(probe)` runs, on the GUI thread (`ToolManager::objectAdded`). Listing
   `"QObject"` (as `guisupport` does) means "load as soon as anything exists".
6. `ProbeSettings::value("DisabledPlugins")` is a `;`-separated list of tool ids that are
   never registered.

## 2. Object tracking

- `Probe::objectAdded()` and `objectRemoved()` are called from the Qt hooks in *any*
  thread. They maintain `m_validObjects` (a `QSet<const QObject*>`) under
  `Probe::objectLock()` (a recursive mutex).
- Objects created from a constructor are queued and announced later from the probe
  thread, once construction has finished (`queueCreatedObject`, then
  `processQueuedObjectChanges`, then `objectFullyConstructed`). The probe then emits:
  - `objectCreated(QObject*)`, after the object is fully constructed, on the GUI thread
  - `objectDestroyed(QObject*)`: the pointer is dangling, so use it only as a key
  - `objectReparented(QObject*)`
- `Probe::allQObjects()` lists every known object. `Probe::isValidObject(obj)` must be
  checked **under `objectLock()`** before you dereference a pointer whose lifetime you
  don't control.
- GammaRay's own objects are filtered out (`filterObject`, `ProbeGuard`). Code that runs
  inside the probe should hold a `ProbeGuard` while it creates helper objects, so they
  are not reported as application objects.
- Object models: `ObjectListModel` and `ObjectTreeModel` (`core/objectlistmodel.*`,
  `core/objecttreemodel.*`), exported through `ObjectBroker` as
  `com.kdab.GammaRay.ObjectList` and `com.kdab.GammaRay.ObjectTree`.
- `ObjectDataProvider` (`core/objectdataprovider.h`) is the extension point for
  "name" and "type name". When the `qmlsupport` plugin is loaded (it loads as soon as a
  `QJSEngine` exists), `ObjectDataProvider::name(obj)` returns the **QML id** (through
  `QQmlContext::nameForObject`) and `ObjectDataProvider::typeName(obj)` returns the
  **QML type name** (for example `QtQuick.Controls/Button`, or the type name of an inline
  `.qml` component). That gives the locator engine QML ids and types **without linking
  QtQml private headers** in the new plugin.

## 3. Communication: ObjectBroker and the remote protocol

- `ObjectBroker` (`common/objectbroker.*`) is a name→`QObject*` and name→model registry.
  On the probe side, `Probe` hooks it up so that registering an object also exports it
  over the `Server`. On the client side, factories create proxies.
- Protocol (`common/protocol.h`, `common/message.*`): length-prefixed binary
  **`QDataStream`** messages addressed by `ObjectAddress` (quint16). The messages are
  object map/add/remove, remote **models** (row/column/data requests per index, with
  `QVariant` payloads), `MethodCall` (method name plus `QVariantList` arguments,
  serialized with `QDataStream`), and `PropertySyncRequest`/`PropertyValuesChanged`.
  Everything assumes both sides are Qt programs with identical `QDataStream` versions
  and the same custom metatype stream operators (`common/streamoperators.cpp`). The
  protocol has an exact version check (`Protocol::version()`).
- Tools follow a three-part pattern:
  - `*Interface` in common code: a `QObject` with signals/slots and `Q_DECLARE_INTERFACE`
  - a probe-side implementation, registered with `ObjectBroker::registerObject`
  - a UI-side `*Client` proxy that forwards calls through `Endpoint::invokeObject`
  - models published with `Probe::registerModel`, consumed with `ObjectBroker::model`

## 4. How existing tools reach objects, properties, signals and events

- **Properties.** `PropertyController` (`core/propertycontroller.*`) and
  `PropertyAdaptor`/`PropertyAggregator`/`PropertyAdaptorFactory` give a uniform
  read/write view over `QMetaProperty`, dynamic properties, QML attached properties,
  `QJsonValue` and similar sources. `QMetaPropertyAdaptor::writeProperty` uses
  `QMetaProperty::write`. Plain `QObject::property()`/`setProperty()` is enough for
  automation.
- **Methods.** `ObjectMethodModel` and `MethodArgumentModel` invoke a method through
  `QMetaMethod::invoke` with arguments converted from strings/variants. The signal
  monitor and `SignalSpyCallbackSet` (`core/signalspycallbackset.*`) hook
  `qt_signal_spy_callback_set` to see **every** signal emission (the probe chains them
  through `Probe::registerSignalSpyCallbackSet`). For waiting on one signal of one
  object, a plain `QMetaObject::connect` to a helper slot (as `QSignalSpy` does) is
  simpler and has no global cost.
- **Widget inspector** (`plugins/widgetinspector`). Probe side is
  `WidgetInspectorServer`: widget tree model, selection, `RemoteViewServer` for remote
  screenshots and input. Side effect: its event filter **makes every shown `QDialog`
  non-modal** (`widgetinspectorserver.cpp:203`). That changes application behaviour, so
  automation sessions should disable this plugin.
- **Quick inspector** (`plugins/quickinspector`). Works on `QQuickWindow`s and the
  `QQuickItem` *visual* tree (`QuickItemModel` uses `childItems()`, which is not the same
  as `QObject::children()`). It grabs frames with `QQuickWindow::grabWindow()` or
  through the scene graph (`quickscreengrabber.cpp`), and can change render modes. It
  links QtQuick private headers.
- **Event injection today.** `RemoteViewServer::sendMouseEvent`, `sendKeyEvent`,
  `sendWheelEvent` and `sendTouchEvent` (`core/remoteviewserver.cpp`) build `QMouseEvent`,
  `QKeyEvent` and similar objects and `postEvent` them straight to the receiver
  (`QWindow`/`QWidget`). That is good enough for a remote view. It skips the
  `QWindowSystemInterface` path (no enter/leave or hover synthesis, no focus-on-press,
  no `QGuiApplication` mouse-state bookkeeping), so it is **not** realistic enough for
  E2E testing. QTest's `mouseClick`/`keyClick` on a `QWindow` go through
  `QWindowSystemInterface::handle*Event` and therefore behave like real input. Both
  work with `QT_QPA_PLATFORM=offscreen`.
- **Screenshots.** `QWidget::grab()` for widgets, `QQuickWindow::grabWindow()` for
  Quick (cropped to the item's scene rect for item-level screenshots).

## 5. Plugin structure and build

- One directory per plugin under `plugins/`, listed in `plugins/CMakeLists.txt`
  (optionally gated on `if(TARGET Qt::Foo)`).
- `gammaray_add_plugin(<target> JSON <file>.json SOURCES …)` (`cmake/GammaRayMacros.cmake`)
  builds a `MODULE` into `${GAMMARAY_OUTPUT_PREFIX}/<probe plugin dir>` with RPATH and
  install rules. Probe-side parts link `gammaray_core`. UI parts (`*_ui_plugin`) link
  `gammaray_ui` and are only built with `GAMMARAY_BUILD_UI`. A headless plugin needs no
  UI part.
- Metadata JSON: `id`, `name`, `types` (lazy-load trigger), `selectableTypes`, and
  `hidden: true` (no tab in the client UI).
- Factory: `class XFactory : public QObject, public StandardToolFactory<QObject, X>`
  with `Q_INTERFACES(GammaRay::ToolFactory)` and
  `Q_PLUGIN_METADATA(IID "com.kdab.GammaRay.ToolFactory" FILE "x.json")`.
  `StandardToolFactory::init` runs `new X(probe, probe)` on the GUI thread.
- Tests use `gammaray_add_probe_test` and `BaseProbeTest::createProbe()`
  (`tests/CMakeLists.txt`, `tests/baseprobetest.h`) to run a probe in the test process.

## 6. Decision: option A, an in-process "automation" probe plugin speaking JSON-RPC over WebSocket

**Option B** (a headless external client using GammaRay's remote protocol) was rejected:

1. **Wrong level of abstraction.** The protocol exposes *GUI models* (index-based object
   trees, property tables, remote-view frames) and per-tool `MethodCall`s. There are no
   "find element / click / wait" primitives. Every action would need new server-side
   methods anyway, which means probe-side code (the main cost of option A) *plus* a
   client.
2. **A Node client is impractical.** The wire format is Qt `QDataStream` with `QVariant`
   payloads, custom stream operators and an exact protocol-version handshake.
   Reimplementing that in TypeScript is large and fragile. The alternative, a C++ Qt
   "bridge" process between Node and the probe, adds a process, a second protocol and
   another build artifact.
3. **Wrong event semantics.** `RemoteViewServer` posts synthetic events directly, which is
   less faithful than QTest's `QWindowSystemInterface` path.
4. **Timing.** Auto-waiting, `waitForSignal` and object-created/destroyed notifications
   are much easier to get right in-process. An event-driven wait can be answered on the
   GUI thread in the same event-loop iteration in which the condition became true.

**Option A** reuses the GammaRay parts that are the hard part: injection (all
injectors, attach, static probe, Android), object tracking with validity checks under
lock, lazy plugin loading, and QML id/type resolution through `ObjectDataProvider`. It
adds one self-contained plugin and needs **no core changes**.

Shape of the plugin (details are recorded in `automation/DECISIONS.md` as they are
decided):

- `plugins/automation/`, built only `if(TARGET Qt::WebSockets AND TARGET Qt::Test)`.
  It is probe-side only, `hidden: true`, and has `types: ["QObject"]` so it starts
  immediately.
- A `QWebSocketServer` living on the **GUI thread** (the plugin is created there), so
  every request handler already runs on the GUI thread. No cross-thread marshalling is
  needed, and none can be forgotten. Long operations (`waitForSignal`, waits) are
  **asynchronous**: the reply is deferred and sent later from a slot or timer, and the
  event loop is never blocked.
- Port: `GAMMARAY_AUTOMATION_PORT` (env, read through
  `ProbeSettings::value("AutomationPort")`, so the launcher can pass it as well).
  Default 0 means "pick a free port". Bind address: `GAMMARAY_AUTOMATION_ADDRESS`
  (default `127.0.0.1`). Readiness is printed to stdout as one machine-readable line,
  `GammaRay automation server listening on ws://127.0.0.1:<port>`, which the Node
  launcher reads through the GammaRay launcher's forwarded stdout. It is optionally
  also written to `GAMMARAY_AUTOMATION_PORT_FILE`.
- Element handles: a per-process monotonically increasing integer mapped to a
  `QPointer<QObject>`. Handles are stable while the object lives and become a clear
  "stale handle" error after destruction. GammaRay's `ObjectId` is not used, because it
  is address-based and addresses get reused.
- Locator engine: runs in-process over the union of the `QObject` tree and the
  `QQuickItem` visual tree (`childItems()`, `QQuickWindow::contentItem()`), with
  `ObjectDataProvider` supplying QML ids and types.
- Input: QTest functions on the target `QWindow` (`QWidget::windowHandle()` or
  `QQuickItem::window()`) in window coordinates, so widgets and Quick items share one
  realistic path.
- Automation sessions should run with
  `DisabledPlugins=gammaray_widgetinspector;…` (the inspector tools aren't needed and
  some have side effects, see §4). `gammaray_qmlsupport` must stay enabled for QML ids.

## 7. Risks and known limitations to watch for in later phases

- `qmlsupport` only loads once a `QJSEngine` exists. Before that, QML ids are
  unavailable, which is harmless because no QML exists yet.
- QML `Popup`/`Dialog` contents are reparented under the window overlay, so descendant
  chaining from the popup must follow `QQuickPopup::contentItem`/`popupItem`. This is
  handled through the visual tree, but it needs testing.
- Offscreen QPA with Qt Quick: needs OpenGL software rasterization (Mesa llvmpipe) or
  `QT_QUICK_BACKEND=software` for `grabWindow()`. CI should set the latter.
- Attach (`--pid`) needs gdb/lldb and ptrace permission, which is often blocked in
  containers.
- Running the plugin with a GammaRay GUI client attached at the same time works, but the
  widget inspector's "make dialogs non-modal" side effect then applies again.
