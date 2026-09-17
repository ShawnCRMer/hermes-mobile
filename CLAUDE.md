# Hermes Mobile

iOS Capacitor shell that loads the unmodified Hermes Agent desktop renderer behind a native `window.hermesDesktop` bridge. Zero patches to upstream source.

## Architecture

- **Upstream source**: git submodule at `upstream/` → `NousResearch/hermes-agent` @ `f159e581c7` (desktop 0.17.0, gateway 0.21.0)
- **Bridge**: `src/bridge/index.ts` — implements all ~130 `window.hermesDesktop` methods, enforced at compile time via `satisfies Window['hermesDesktop']`
- **Build**: Vite config inherited from upstream via `mergeConfig()` — do NOT re-declare upstream aliases
- **Types**: `tsconfig.json` extends `upstream/apps/desktop/tsconfig.json` — path aliases `@/*`, `@upstream/*`, `@hermes/*` are there
- **Entry**: `src/main.ts` installs bridge, then `await import('@upstream/main.tsx')` loads the upstream renderer
- **iOS**: Capacitor 8.4.2, Xcode project in `ios/`, builds for iPhone 17 Pro simulator (iOS 26.5)
- **ADRs**: `docs/adr/ADR-001-mobile-architecture.md` (bridge/shell) and `ADR-002-local-gateway.md` (embedded Python gateway + on-device inference, future)

## Key decisions

- Upstream deps installed via `npm ci` in `upstream/` (postinstall), NOT duplicated in mobile's package.json
- `babel-plugin-react-compiler` is a devDep here because Babel resolves plugins from CWD
- Bridge uses `CapacitorHttp` for ALL native platform requests (WKWebView blocks cross-origin fetch from capacitor:// to 127.0.0.1)
- Dev/preview servers proxy `/api` and `/api/ws` to the gateway (configured via `HERMES_GATEWAY_URL` env var, default `http://127.0.0.1:9119`)
- `html[data-hermes-host="mobile"]` CSS scoping for mobile-specific styles in `src/styles/mobile.css`

## Commands

```bash
npm run build          # Vite production build → dist/
npm run dev            # Dev server at 0.0.0.0:5175
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint
npm run test:webkit    # Playwright WebKit smoke tests (needs a running gateway)
npm run sync           # cap sync ios
npm run ios            # Open Xcode project
npm run bump-upstream  # Move submodule pin, verify parity
npm run scan-bridge-usage  # Bridge method drift detector
```

## Running smoke tests

The WebKit smoke tests need a Hermes gateway. To start a test gateway with a known token:

```bash
HERMES_DASHBOARD_SESSION_TOKEN=test-smoke-token HERMES_DESKTOP=1 \
  ~/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main serve --host 127.0.0.1 --port 9119

# Then in another terminal:
HERMES_GATEWAY_URL=http://127.0.0.1:9119 HERMES_SESSION_TOKEN=test-smoke-token \
  npm run test:webkit
```

The test auto-scrapes the session token from the gateway's root page if `HERMES_SESSION_TOKEN` is not set.

## Python layer gotcha (local mode)

`scripts/build-python-layer.sh` (no arguments) produces a platform-neutral `ios/App/python/`: pure-Python stdlib without `lib-dynload`, plus both the `iphoneos` and `iphonesimulator` builds of the native wheels side by side. The Xcode target's last build phase, "Prepare Python Binary Modules" (`scripts/xcode-prepare-python-modules.sh`), then copies the platform-correct `lib-dynload` out of `Python.xcframework`, deletes the other platform's `.so` files, relocates every extension module into a signed `Frameworks/<dotted.name>.framework`, and leaves the `.fwork` stub CPython's iOS loader follows. Do NOT bake `.fwork` stubs or `ios/App/Frameworks/<module>` directories into the layer again — that is what shipped a simulator-only layer to a physical device and broke local mode. Python boot failures write the traceback to `Caches/hermes-boot-error.txt` (surfaced in the boot-failure overlay) and the gateway log to `Caches/hermes-python.log`.

## Capacitor gotcha

After `cap sync`, Capacitor overwrites `capacitor.config.json` with defaults. If custom plugins are added, copy the source config back after every sync.

## CapacitorHttp gotcha

`CapacitorHttp` on iOS only attaches `data` when a `Content-Type` header is set (`CapacitorUrlRequest.setRequestBody`). Any new native request with a body must set the header explicitly — `nativeRequest` in `src/bridge/index.ts` does this for JSON; do not bypass it.

## GitHub and CI policy

Private repo at https://github.com/ShawnCRMer/hermes-mobile.

**No GitHub Actions. No CI workflows. All testing is local.** Do NOT create `.github/workflows/` files or suggest adding CI. Run typecheck, lint, and smoke tests locally before every push. This is a deliberate choice — the project uses zero GitHub Actions minutes.

The goal is to build this to a quality where it can be gifted to the Hermes/Nous Research community as a contribution (potentially adopted as `apps/mobile/` in the upstream repo per ADR-001 D9). We are not managing external PRs — if Nous adopts it, CI becomes their responsibility.

## Enterprise audit lessons (from messaging app, applied here)

Findings from a prior enterprise quality audit that apply to mobile-owned code:

- **Haptics**: Use Capacitor native Haptics, not web AudioContext. Upstream's web-haptics don't reach the Taptic Engine. Phase 2 item.
- **Edge-swipe gesture**: Implement properly with velocity threshold and cancel zone. Phase 1 item.
- **rAF / timer leaks**: Any mobile-owned animation or polling code must clean up on unmount/disconnect.
- **Request deduplication**: Bridge `api()` should dedupe rapid-fire identical requests (upstream fires bursts on boot/reconnect).
- **Loading / reconnect states**: Show shimmer or skeleton during gateway reconnect, not a flash of empty content.
- **Offline indicator**: Essential for local mode (Phase L0+) — show clear offline/online state.
- **Memoization**: Bridge callback registrations should not cause unnecessary React re-renders.

These don't apply (upstream owns them): scroll model, SQL injection, rich conversation rows, typing/presence, batch DB queries.

## Current status

**Phase 0: COMPLETE** (all 7 exit criteria met)

**Phase 1: COMPLETE** (usable daily driver)

What shipped:
1. Password-provider PKCE auth + iOS Keychain storage (`@aparajita/capacitor-secure-storage`)
2. mobile.css polish — safe areas, 44-48px touch targets, momentum scrolling, dialog/sheet/popover sizing, tooltip suppression, reduced motion, focus-visible
3. File attach (native picker) + iOS share sheet export (`@capacitor/filesystem`, `@capacitor/share`)
4. Local notifications for turn completion (`@capacitor/local-notifications`)
5. Edge-swipe gesture (left edge → sidebar) with velocity threshold, cancel zone, haptic tick
6. Bridge request deduplication (enterprise audit item)
7. Parity suite: 28 tests — bridge contract, upstream touchpoint SHA snapshots, auth ladder fixtures
8. Bridge manifest updated: 7 methods upgraded from stub/omit → impl

Enterprise audit items completed: request dedup, timer cleanup pattern (no leaked timers in auth refresh), edge-swipe velocity threshold + cancel zone.

**Phase 2: IN PROGRESS** (native integration)

What has shipped:
1. Native haptics via Capacitor `@capacitor/haptics` — registered through upstream's `registerHapticTrigger` seam so all upstream `triggerHaptic()` calls reach the Taptic Engine. Edge-swipe haptic upgraded from `navigator.vibrate` to native impact.
2. Deep links (`hermes://`) via `@capacitor/app` `appUrlOpen` — `onDeepLink` and `signalDeepLinkReady` bridge methods now implemented (were omitted). URLs parsed into `{kind, name, params}` format. Queues links received before renderer signals ready.
3. Battery/power signals via `@capacitor/device` — `getOnBattery` and `onBatteryChanged` now implemented (were omitted). 30s polling with change detection. Upstream uses these to demote background polling on battery.
4. Offline indicator via `@capacitor/network` — fixed banner at top when connectivity drops, auto-hides on reconnect. Theme-aware (red background adapts to dark mode).
5. Reconnect shimmer CSS — `[data-slot="mobile-shimmer"]` keyframe animation for loading states.
6. Theme marketplace via `CapacitorHttp` — `searchMarketplace` (gallery API) and `fetchMarketplace` (VSIX download + browser-native zip parsing via `DecompressionStream`) fully ported from Electron's Node.js implementation.
7. Status bar theming via `@capacitor/status-bar` — `setNativeTheme` sets iOS status bar style (dark/light/system).
8. Keep-awake via Screen Wake Lock API (`navigator.wakeLock`) — `setKeepAwake` prevents screen dimming during long sessions.
9. Bridge manifest updated: 7 methods upgraded from stub/omit → impl (themes, setNativeTheme, setKeepAwake, getOnBattery, onBatteryChanged, onDeepLink, signalDeepLinkReady).
10. Share Extension — iOS share sheet target (`ShareExtension` Xcode target, `SLComposeServiceViewController`) writes to App Group (`group.com.mobilehermes.app`) shared container, deep links `hermes://share/incoming` to hand off to the renderer, `share-intake.ts` reads payload and inserts into composer.
11. Voice input — see `docs/adr/ADR-003-voice-audio-mobile.md`. WKWebView hides `navigator.mediaDevices` unless Info.plist declares `NSMicrophoneUsageDescription` (measured); `MediaRecorder` (webm/opus) works. Native JSON request bodies need an explicit `Content-Type` or CapacitorHttp drops them ("Autosave failed").
12. iPad layout polish — centered dialogs (max-width 560px, border-radius 16px) and command palette on ≥640px screens instead of full-width bottom sheets.

Still gated on upstream PR (Phase 2 deferred item):
- System-browser OAuth (`ASWebAuthenticationSession`) + Hermes Cloud sign-in

## TestFlight build

Prerequisites: Apple Developer Program enrollment, Xcode with signing configured.

```bash
npm run build          # Vite production build → dist/
npx cap sync ios       # Copy web assets + sync plugins
npx cap open ios       # Open Xcode
```

In Xcode:
1. Select the "App" target → Signing & Capabilities
2. Set Team to your Apple Developer team
3. Set Bundle Identifier to `com.mobilehermes.app`
4. Product → Archive (select "Any iOS Device" as destination)
5. Window → Organizer → Distribute App → TestFlight (App Store Connect)

**Phase L0: COMPLETE** (embedded Python gateway)

See ADR-002 for full spec. The goal: run `hermes serve` in-process on iOS via embedded CPython 3.13.

What has shipped:
1. `python/hermes_mobile_boot.py` — psutil stub, debug Popen wrapper, shutdown hook. Seeds `sys.modules['psutil']` before any Hermes import.
2. `python/requirements.ios.txt` — iOS dependency manifest generated from upstream uv.lock (56 packages classified: pure-Python, BeeWare wheels, cross-build).
3. `python/ios_config.yaml` — default local-mode config with safe toolsets only (no terminal/code_execution/browser/computer_use).
4. `scripts/fetch-python-framework.sh` — downloads BeeWare's `Python-3.13-iOS-support` xcframework (checksum-verified).
5. `scripts/build-ios-wheels.sh` — cross-compiles pydantic-core, jiter, cryptography for iOS device+simulator via maturin.
6. `scripts/build-python-layer.sh` — packages stdlib + app_packages + pruned Hermes tree, .so→.fwork rewrite for code signing.
7. `ios/App/Sources/HermesGateway/PythonRuntime.swift` — CPython host: env setup, interpreter init, `start_server(port=0)` on a background thread, ready-file polling, shutdown hook.
8. `src/bridge/local-connection.ts` — `mode:'local'` connection descriptor, boot progress, WS/HTTP for loopback, registry entry.
9. Bridge `index.ts` updated: `getConnection`, `getConnectionFor`, `getGatewayWsUrl`, `api`, `onBootProgress`, `saveConnectionConfig`, `connections.list`, `onPowerResume` all route through local mode when enabled.
10. Bridge manifest upgraded to two-column format (`remote`/`local` status per method).
11. `scan-bridge-usage.mjs` updated to validate the two-column manifest format.

Also shipped (Xcode integration commit):
12. `App-Bridging-Header.h` — bridges CPython C API (`#include <Python/Python.h>`) with `__has_include` guard.
13. `project.pbxproj` updated: Python.xcframework linked + embedded, HermesGateway group, bridging header, `HERMES_LOCAL_MODE` compilation condition.
14. `AppDelegate.swift` lifecycle: `beginBackgroundTask` on background, restart-if-dead on foreground, `stop()` on terminate.
15. `App.entitlements`: `increased-memory-limit` for local inference.
16. Spawn audit PASSED: 487 call sites analyzed, **zero** on boot path, **zero** on chat happy path. All reachable sites guarded by toolset config or OSError(45) handlers. Results recorded in ADR-002 Appendix.
17. Bundle-size measurements recorded in ADR-002 Appendix: stdlib 16 MB, hermes 39 MB, total 55 MB without app_packages.

Also shipped (wheel build):
18. iOS wheels built: pydantic-core 2.46.4 (1.8 MB) + jiter 0.16.0 (288 KB) for device and simulator via maturin cross-compilation. Cryptography omitted (only needed by Bitwarden secrets + Weixin adapter, not on iOS path).

Also shipped (on-device validation):
19. Device build + install on iPhone 17 Pro Max (ElTelephono) — code signing with DEVELOPMENT_TEAM, automatic provisioning.
20. Cold-start measurement: **<200ms** process creation to WebView loaded (target was <6s). Full Python layer bundled (151 MB). Recorded in ADR-002 Appendix.

All L0 exit criteria met.

**Phase L1: IN PROGRESS** (on-device inference)

See ADR-002 D5 for spec. The goal: run ML models on-device via MLX Swift and expose them to the Hermes gateway through an OpenAI-compatible loopback server.

What has shipped:
1. `ios/App/Sources/HermesGateway/LocalInferenceServer.swift` — Hummingbird 2 HTTP server on loopback, OpenAI-compatible: `/v1/chat/completions` (SSE streaming + non-streaming), `/v1/models`, `/props` (llama-server fingerprint for Hermes auto-detect), `/health`. Thermal throttling of `max_tokens` under `.serious`/`.critical`.
2. `ios/App/Sources/HermesGateway/MLXInferenceEngine.swift` — MLX Swift inference engine (`MLXLLM`/`MLXLMCommon`). Loads safetensors models from local directories. Streaming token generation via `ModelContainer.generate()`. Built-in tool call parsing for Qwen3/Llama3/Gemma formats.
3. `ios/App/Sources/HermesGateway/ModelStore.swift` — Model catalog (Qwen3-4B, Hermes-3 3B, Qwen3-1.7B, Gemma 3n E2B), background `URLSession` downloads from HuggingFace, resumable, SHA-checked. Storage under Application Support/models, excluded from iCloud backup. Load/unload/evict lifecycle.
4. `ios/App/Sources/HermesGateway/ModelManagerPlugin.swift` — Capacitor plugin (`ModelManager`) exposing model management to WebView: getStatus, downloadModel, cancelDownload, deleteModel, setActiveModel, getInferencePort. Pushes state changes via `notifyListeners`.
5. `src/bridge/model-manager.ts` — TypeScript model manager state: catalog, download progress, active model, storage usage. Persists to localStorage. Listens for Capacitor plugin events.
6. `src/bridge/network.ts` — Upgraded offline indicator: four modes (online, local-only, offline-local, offline-cloud). When offline + cloud provider: warns before send. When on-device model active: "offline" is capability, not error.
7. `AppDelegate.swift` updated: starts PythonRuntime + LocalInferenceServer on launch (when HERMES_LOCAL_MODE), thermal state observer evicts model on `.serious`/`.critical`, memory warning evicts model + engine.
8. SPM dependencies added to Xcode project: Hummingbird 2, mlx-swift-lm (MLXLLM + MLXLMCommon).

L1 bugs fixed (2026-09-08):
- **Bug A FIXED:** `ModelStore.setActiveModel` now async — creates `MLXInferenceEngine`, loads model, passes to `LocalInferenceServer.shared.setEngine()`. Full chain: activate → load → engine → server.
- **Bug B FIXED:** Three-part fix: (1) `python/ios_config.yaml` now has `model:` section pointing at loopback, (2) `scripts/build-python-layer.sh` bundles it, (3) `python/hermes_mobile_boot.py` deploys it to `HERMES_HOME/config.yaml` at boot.
- **Bug C FIXED (2026-09-08):** Stale `.pyc` in Python layer's `__pycache__/` was overriding the updated `.py` for config deployment. The old bytecode had no config deployment code. Fix: deleted `hermes_mobile_boot.cpython-313.pyc` from `ios/App/python/hermes/__pycache__/`. Also switched deployment log from `logger.info()` (no handler → silent) to `print(file=sys.stderr)` (captured by Tee to hermes-python.log). **Must delete stale .pyc files whenever updating .py files in the Python layer.**
9. `src/bridge/model-manager-ui.ts` — Pure DOM model manager overlay: FAB button + slide-up sheet with local inference toggle, model catalog cards (download/load/unload/delete), progress bars, storage display. Re-renders on state changes.
10. `MLXInferenceEngine.swift` — `#if targetEnvironment(simulator)` guard throws `InferenceError.simulatorNotSupported` instead of SIGABRT crash when MLX tries to init Metal compute.

L1 simulator validation (2026-09-08):
- ✅ Inference server: starts on 127.0.0.1:8080, responds to /health, /v1/models, /props
- ✅ No-model error: returns `{"error":{"message":"no model loaded"}}` for both streaming and non-streaming
- ✅ Python gateway: starts, serves session token, auth works
- ✅ Config auto-deploy: `ios_config.yaml` → `HERMES_HOME/config.yaml` on first boot (after Bug C fix)
- ✅ Gateway config: reads `model: "local"`, `base_url: "http://127.0.0.1:8080/v1"`, correct toolsets
- ✅ Simulator guard: MLXInferenceEngine.loadModel throws gracefully instead of Metal crash
- ❌ **Actual inference blocked in simulator** — MLX requires Metal compute (real Apple Silicon). Tests need physical device (ElTelephono).

Still TODO for L1 exit criteria (requires physical device):
- End-to-end inference test with Qwen3-1.7B (smallest model for fast iteration)
- End-to-end tool calling verification with Qwen3-4B on `memory` and `web` toolsets
- Airplane-mode chat verification

**Phase M0: COMPLETE** (mobile shell)

What shipped:
1. `src/shell/main.tsx` — mobile entry point: replicates upstream provider stack (QueryClient, I18n, Theme, Haptics, Tooltip, HashRouter) but mounts `MobileShell` instead of `ContribController`.
2. `src/shell/mobile-shell.tsx` — `ContribWiring` wrapping a tab-bar layout. Chat and Sessions panes stay mounted for react-router state preservation (visibility toggled via CSS). Auto-switches from Sessions to Chat tab when a session is selected.
3. `src/shell/tab-bar.tsx` — Three-tab iOS-style tab bar: Chat, Sessions, Settings. SVG icons, safe-area-inset-bottom padding, theme-aware.
4. `src/shell/settings-tab.tsx` — Connection switcher (lists all registered gateways, highlights active, switches with reload), Model Manager shortcut, All Settings link (opens upstream settings overlay), OG/Desktop mode toggle.
5. `src/main.ts` updated — checks `localStorage['hermes:shell']`: `'desktop'` loads upstream renderer, default loads mobile shell.
6. `src/styles/mobile.css` — ~200 lines of shell CSS: layout (flex column, full dvh), tab bar, settings tab (iOS-style grouped cards), pane visibility, titlebar suppression, theme tokens (light/dark).
7. `scripts/link-upstream-deps.sh` + postinstall hook — symlinks React/router/stores from upstream's `node_modules` so TypeScript resolves a single copy of each type definition.

Architecture: `ContribWiring` (headless business logic) + `WiredPane` surfaces (sidebar, chatRoutes, terminal, statusbar) are reused unchanged. `ContribController` (desktop chrome: LayoutTreeRoot, titlebar, pane registry) is replaced. All upstream overlays (settings, model picker, onboarding, notifications) render as siblings to `children` inside the ContribWiring provider and float above the mobile layout automatically.
