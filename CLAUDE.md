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

Next: Phase 1 — Usable daily driver. See `docs/adr/ADR-001-mobile-architecture.md` line 218 for the full scope. Recommended attack order:
1. Password-provider PKCE auth + Keychain storage
2. mobile.css polish pass (touch targets, safe areas, sidebar)
3. File attach + share sheet
4. Local notifications for turn completion
5. Edge-swipe rails
6. Parity suite + TestFlight build
