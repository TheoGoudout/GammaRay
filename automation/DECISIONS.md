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
- **Chosen: QTest** (`QTest::mouseClick`, `keyClick` and related functions on the
  target `QWindow`). Linking Qt::Test into the optional plugin is acceptable. QTest goes
  through `QWindowSystemInterface`, which is the closest thing to real input, and it
  works with the offscreen QPA.

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
