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

## Capacitor gotcha

After `cap sync`, Capacitor overwrites `capacitor.config.json` with defaults. If custom plugins are added, copy the source config back after every sync.

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
11. Voice input — verified complete, no additional work needed. Bridge's `requestMicrophoneAccess` uses `getUserMedia`, upstream's `use-mic-recorder.ts` uses standard `MediaRecorder` API which works in WKWebView.
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

**Phase L0: IN PROGRESS** (embedded Python gateway)

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

Remaining for L0 exit (require hardware/toolchain):
- Run the wheel job (pydantic-core, jiter, cryptography iOS wheels) — requires `rustup target add aarch64-apple-ios`
- On-device cold-start measurement (target: <6s on iPhone 15 Pro) — requires physical device
