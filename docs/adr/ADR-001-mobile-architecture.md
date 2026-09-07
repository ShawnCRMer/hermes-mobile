# ADR-001: Hermes Mobile architecture — an unmodified upstream renderer behind a native bridge

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-09-07 |
| **Upstream pin analysed** | `NousResearch/hermes-agent` @ `f159e581c7` (desktop `0.17.0`) |
| **Audience** | Contributors to this repo, the Hermes community, Nous Research |

## Context

Hermes Desktop (`apps/desktop/` in `hermes-agent`) is a React 19 / Vite 8 / Tailwind v4 renderer hosted in Electron. The renderer never touches Node or Electron APIs directly: every native capability crosses one typed seam, `window.hermesDesktop`, declared in `apps/desktop/src/global.d.ts` (~550 lines, ~130 methods) and implemented by `apps/desktop/electron/preload.ts`. The renderer talks to the Hermes gateway over REST (`hermesDesktop.api()`) and a JSON-RPC WebSocket (`/api/ws`).

We want an iOS app (Android later) that is the *same product* — same chat surface, same settings, same session model — connecting to a Hermes gateway the user already runs on a homelab, VPS, or Hermes Cloud. Building a second UI is the wrong move: the desktop renderer is 1,100+ source files receiving **~470 commits a month** in `src/` alone. Any hand-ported UI would be permanently behind.

The single most important property of this project is therefore: **upstream desktop changes must flow into mobile with near-zero friction, and mobile must carry zero patches against upstream source.**

Constraints that shape the decision:

- This is a **separate public repository**, not a PR into `hermes-agent`. It must still be trivially mergeable into `apps/mobile/` if Nous Research wants it.
- The desktop renderer already feature-detects the bridge: 211 of 366 call sites use optional chaining (`window.hermesDesktop?.x?.()`), and Nous's own contribution rules (`apps/desktop/AGENTS.md`, "Cross everything as an observable ladder") require that "a missing capability … may enable a compatibility path or a disabled state". Mobile can lean on that contract rather than fork around it.
- The gateway already implements RFC 8252 native-app auth (`hermes_cli/dashboard_auth/native_flow.py`, `routes.py`) for the desktop, with bearer tokens, refresh, and single-use WebSocket tickets. Mobile should be a second client of that machinery, not a third auth model.
- No Node built-ins are imported anywhere in `apps/desktop/src` (verified), so the renderer bundle is WKWebView-viable in principle.

## Decision

Hermes Mobile is a **Capacitor (iOS first) shell that loads the unmodified upstream desktop renderer**, sourced from a **git submodule pinned to a specific `hermes-agent` commit**, built with the **upstream Vite configuration inherited via `mergeConfig`**, with a **`window.hermesDesktop` bridge installed as a polyfill before the renderer's module graph evaluates**, and a **single mobile stylesheet layered after upstream's**. Everything mobile-specific lives in this repo; nothing in `upstream/` is ever edited.

### D1. Source acquisition: git submodule, pinned, with upstream's own lockfile

```
hermes-mobile/
├── upstream/                     # git submodule → NousResearch/hermes-agent @ <sha>
├── index.html                    # mobile shell page (mobile-owned copy of upstream's)
├── src/
│   ├── main.ts                   # install bridge, THEN dynamic-import upstream main.tsx
│   ├── bridge/                   # the window.hermesDesktop implementation (see D4)
│   └── styles/mobile.css         # the only mobile CSS (see D6)
├── ios/                          # Capacitor-generated Xcode project
├── capacitor.config.ts
├── vite.config.ts                # mergeConfig(upstream desktop config, mobile overrides)
├── tsconfig.json                 # extends upstream/apps/desktop/tsconfig.json
├── scripts/
│   ├── bump-upstream.sh          # move the pin, reinstall, run parity suite
│   └── scan-bridge-usage.mjs     # drift detector (see D8)
├── tests/                        # contract, parity, WebKit smoke
└── docs/adr/
```

- `upstream/` is a full submodule of `hermes-agent` (source only; ~all of it is Python/docs we ignore). Sparse checkout is not worth the tooling friction.
- Dependencies come from **upstream's `package-lock.json`**: `postinstall` runs `npm ci --workspace apps/desktop` inside `upstream/` (which also installs `apps/shared` via its `file:../shared` dependency). Mobile's own `package.json` holds only Capacitor, its plugins, Playwright, and test tooling.
- The pin is bumped by `scripts/bump-upstream.sh`, never by hand, and every mobile release records its upstream SHA in the About screen (`getVersion().hermesRoot`).

Why this beats the alternatives:

| Alternative | Why rejected |
|---|---|
| Sibling `apps/mobile/` inside the monorepo (original proposal) | Incompatible with a separate public repo. Kept as the *destination* if Nous adopts the project (see D9). |
| npm package of the renderer | Nous does not publish one. `@hermes/shared` is `"private": true` with a `file:../shared` dependency; `main.tsx` mounts itself. Would require an upstream refactor first. |
| `git subtree` | Vendors the entire `hermes-agent` history into this repo, makes bumps a merge instead of a pointer move, and invites "just a tiny local patch". |
| Copy-on-release script | Silent rot: nothing forces the copy to be current, and the copied tree loses its provenance. |
| Fork `hermes-agent` and add `apps/mobile/` there | Every upstream sync is a rebase across 20 commits/day; the fork becomes the product. |

Installing upstream's lockfile (rather than declaring the desktop's 70 dependencies in our own `package.json`) matters for three concrete reasons found in the current tree: (1) `vite.config.ts` resolves `react`/`react-dom` from the desktop workspace directory to guarantee a single React copy (Minified React error #527 otherwise); (2) `styles.css` hard-codes `url('../../../node_modules/@nous-research/ui/dist/fonts/Collapse-Bold.woff2')`, which only resolves if `node_modules` sits at `upstream/node_modules`; (3) root `package.json` carries security `overrides` (mermaid, dompurify, undici…) that we should inherit rather than re-audit.

### D2. Build: inherit the upstream Vite config

Mobile's `vite.config.ts` imports the upstream config **function** and merges, rather than re-declaring aliases:

```ts
// vite.config.ts (mobile)
import path from 'node:path'
import { defineConfig, mergeConfig, type ConfigEnv } from 'vite'
import upstream from './upstream/apps/desktop/vite.config'

const UP = path.resolve(__dirname, 'upstream/apps/desktop')

export default defineConfig(async (env: ConfigEnv) => {
  const base = typeof upstream === 'function' ? await upstream(env) : upstream
  return mergeConfig(base, {
    root: __dirname,                         // mobile index.html + src/
    build: { outDir: path.resolve(__dirname, 'dist'), emptyOutDir: true },
    server: { host: '0.0.0.0', port: 5175, strictPort: true,
              fs: { allow: [__dirname, UP, path.resolve(UP, '../..')] } },
    resolve: { alias: { '@upstream': path.resolve(UP, 'src') } }
  })
})
```

What we inherit for free and must not re-implement: `@`, `@hermes/shared`, `@hermes/shared/billing`, `@hermes/plugin-sdk`, the `@/debug/dev-only` dev/prod swap, the React-Compiler Babel preset, `@tailwindcss/vite`, the emojibase offline assets, the `advancedChunks` vendor groups, the PostCSS pin, and the `driver.js` raw-IIFE aliases. `tsconfig.json` likewise `extends` upstream's and only widens `include` to `src/` and `upstream/apps/desktop/electron` (needed because `global.d.ts` imports `PoolLimits` from `../electron/pool-limits`).

Rejected: a mobile-owned Vite config with `'@': '../desktop/src'`. It reproduces a 240-line file of hard-won fixes and breaks the day Nous adds an alias. The two upstream files already encode the same mapping differently (`tsconfig.json` lists `@hermes/shared/translucency` explicitly; `vite.config.ts` covers it through the `@hermes/shared` prefix alias) — exactly the kind of detail a hand copy gets subtly wrong.

Churn evidence (last 90 days): `vite.config.ts` 3 commits, `global.d.ts` 22, `src/` ~1,400. Inheriting the config attaches us to the slowest-moving surface.

### D3. Entry: bridge as a polyfill, then dynamic-import the upstream entry

```ts
// src/main.ts (mobile)
import { installHermesMobileBridge } from './bridge'
import './styles/mobile.css'

await installHermesMobileBridge()          // async: Keychain + Preferences + Capacitor plugins
await import('@upstream/main.tsx')         // upstream's real entry, untouched
```

`index.html` is a **mobile-owned copy** of upstream's (it is 40 lines and rarely changes), adding `viewport-fit=cover`, `user-scalable=no`, and loading `/src/main.ts`. The pre-paint theme script is kept verbatim.

Why dynamic import rather than "import install.ts then re-export main.tsx": upstream `main.tsx` has five side-effect imports (`store/active-work`, `store/power`, `store/translucency`, …) that call `window.hermesDesktop?.setActiveWork`/`setTranslucency` at module-evaluation time, and the bridge needs *async* initialization (reading the connection registry from Preferences, tokens from Keychain) before `use-gateway-boot.ts` calls `getConnection()`. A top-level `await` before a dynamic import makes ordering explicit and testable. Nothing in upstream's mount path (`createRoot(document.getElementById('root'))`, `HashRouter`, the `?win=` switch) needs to change.

### D4. The bridge interface contract

The bridge is one object, assembled from small modules, that **must satisfy `Window['hermesDesktop']` from the pinned `global.d.ts`** (enforced at compile time; see D8). Methods are classified by how upstream calls them (counts from `grep` of non-test `src/` at the pin):

**Legend.** *Required* = typed non-optional or called without `?.` (34 distinct methods, `api` alone 34 call sites). *Optional* = typed `?:` and always guarded upstream — we may omit and the UI hides itself.

#### A. Must-implement (boot path and core transport)

| Method | Mobile implementation |
|---|---|
| `getConnection(profile?)`, `getConnectionFor({connectionId, profile})` | Resolve from the mobile connection registry (Preferences + Keychain). Returns `HermesConnection` with `mode:'remote'`, `authMode:'token'|'oauth'`, `baseUrl`, `wsUrl`, `token`, `isFullscreen:false`, `nativeOverlayWidth:0`, `windowButtonPosition:null`, `logs:[]`, `remoteKind:'url'|'cloud'`. |
| `getGatewayWsUrl(profile?)`, `getGatewayWsUrlFor(...)` | Token mode: `wss://…/api/ws?token=…`. Bearer mode: `POST /api/auth/ws-ticket` with `Authorization: Bearer`, return `…/api/ws?ticket=…`. Tickets are 30 s single-use — mint on every dial, never cache (upstream rule). Return `{ok:false, needsOauthLogin:true, error}` on 401 so `resolveGatewayWsUrl` raises `GatewayReauthRequiredError`. |
| `api(request)` | Mirror the `hermes:api` handler in `electron/main.ts`: resolve base URL by `connectionId`; header `X-Hermes-Session-Token` (token mode) or `Authorization: Bearer` (native flow, single-flight refresh via `/auth/native/refresh` on 401); `profile` → `?profile=` query; `upload` → multipart; `timeoutMs` → abort. Use `CapacitorHttp` (native URLSession) so cookies/CORS/keep-alive are handled natively and ITP is irrelevant. Retry policy copied from `electron/api-transport.ts`: idempotent verbs retry on transient errors; non-idempotent only when the request provably never left. |
| `revalidateConnection()` | `GET /api/status` probe; `{ok, rebuilt:false}`. |
| `touchBackend`, `getPoolLimits`, `setPoolLimits` | No pool on mobile: `{ok:true}`, defaults. |
| `getProfileRoutes(profiles)` | `[]` (no local plugin routes). |
| `getAgentRoster()` | Enumerate registry connections → `/api/profiles` per source. Optional upstream, but the multi-connection sidebar is a Phase 1 feature. |
| `getBootProgress()`, `onBootProgress(cb)` | Immediately `{running:false, progress:100, phase:'ready', error:null, fakeMode:false, message:'', timestamp}`; callback fires once. The renderer's boot overlay dismisses. |
| `getBootstrapState()`, `onBootstrapEvent`, `continueBootstrapLocal`, `resetBootstrap`, `repairBootstrap`, `cancelBootstrap` | `{active:false, manifest:null, stages:{}, …}`; events never fire; actions `{ok:false}`. No local install on iOS. |
| `getVersion()` | `{appVersion, electronVersion:'', nodeVersion:'', platform:'ios', hermesRoot:'<upstream sha>'}`. |
| `getConnectionConfig`, `saveConnectionConfig`, `applyConnectionConfig`, `testConnectionConfig`, `probeConnectionConfig` | **Reuse upstream's Settings → Gateway UI as the mobile connection editor.** Persist to Preferences; secrets to Keychain. `mode` is always `'remote'` or `'cloud'` (`'local'`/`'ssh'` rejected with a clear error). `probe` = `GET /api/status` + `GET /api/auth/providers`. |
| `connections.{list,save,remove,setPrimary,setLaunchMode,setLastUsed,test,onChanged}` | v2 registry, same storage. `updateManaged`/`updateAll` omitted (optional). |
| `oauthLoginConnectionConfig(url)`, `oauthLogoutConnectionConfig(url)` | Phase 1: password-provider native PKCE (D5). Phase 2: system-browser OAuth. |
| `getSecretStorageEncryption`/`setSecretStorageEncryption` | Always `{on:true}` (Keychain). |
| `profile.{get,remember,set}` | Persist; `set` re-dials rather than relaunching. |
| `openExternal(url)` | Capacitor `Browser.open` (SFSafariViewController) for http(s); `App.openUrl` otherwise. Called 26× upstream. |
| `writeClipboard`/`readClipboard` | Capacitor `Clipboard`. |
| `notify(payload)` | Capacitor `LocalNotifications`; `onNotificationAction`/`onNotificationActivate` wired to `localNotificationActionPerformed`. |
| `requestMicrophoneAccess()` | Permission request; voice input uses the gateway's transcription API through `api()`. |
| `onPowerResume(cb)` | Capacitor `App.resume` → the renderer's existing reconnect-after-wake path. **This is what makes backgrounding work.** |
| `getOnBattery`, `onBatteryChanged` | `Device.getBatteryInfo`; the renderer uses it to demote polling. |
| `setActiveConnectionRoute`, `claimAmbientCue` | Store; `true`. |
| `zoom.{get,factor,setPercent,onChanged}` | Constant 100 %. |
| `glassSupported:false`, `translucencySupported:false`, `localModelsEnabled:false` | Static facts. |

#### B. Mobile-native replacements (same contract, different UX)

| Method | Mobile implementation |
|---|---|
| `selectPaths(opts)` | Photo picker / `UIDocumentPicker` → returns Capacitor file URIs. Directories unsupported → `[]`. |
| `getPathForFile(file)` | Returns the object URL/URI the picker produced. |
| `readFileDataUrl`, `readFileDataUrlForAttach`, `dataUrlReadMax` | `Filesystem.readFile` on picker URIs; cap 25 MB. |
| `saveImageBuffer`, `saveImageFromUrl`, `saveClipboardImage`, `saveGatewayFile`, `selectSavePath` | Write to app cache then present the iOS **Share sheet** (Capacitor `Share`) / save to Photos. `saveGatewayFile` downloads through `api()` with auth headers. |
| `setNativeTheme(mode)` | Capacitor `StatusBar.setStyle`. |
| `setKeepAwake(on)` | Capacitor `KeepAwake`. |
| `fetchLinkTitle`, `resolveFavicon` | Native fetch via `CapacitorHttp` (no CORS). |
| `themes.{fetchMarketplace,searchMarketplace}` | VS Code Marketplace JSON API via `CapacitorHttp`. Phase 2; Phase 1 rejects with "unsupported on mobile". |
| `onDeepLink`, `signalDeepLinkReady` | Capacitor `App.appUrlOpen` for `hermes://` links and the Phase 2 OAuth callback. |
| `revealLogs`, `getRecentLogs`, `logsRoot`, `reportRendererError` | In-app ring buffer + Share-sheet export. |
| `cloud.{status,login,logout,discover,agentSignIn}` | Phase 2 (Hermes Cloud via `ASWebAuthenticationSession`). Phase 1: `status → {signedIn:false}`, `login → {ok:false}`. |

#### C. Stub (typed required, but the feature has no mobile meaning)

Return a well-formed failure so the calling UI degrades exactly as it does on an older desktop shell:

`openSessionWindow`, `openWindow`, `openBrowserWindow`, `openSessionInTerminal` → `{ok:false, error:'unsupported'}` · `onBrowserPopoutClosed` → no-op unsubscribe · `quickEntry.getSettings/setSettings` → `{enabled:false, registered:false}`; other `quickEntry.*` inert · `petOverlay.*` inert (`open → {ok:false}`) · `terminal.start` rejects `'unsupported'`, others `false` · `findInPage → {count:0}`, `stopFindInPage`, `onFoundInPage`, `onOpenFindBarRequested` inert · `updates.check → {supported:false}`, `updates.apply → {ok:false, manual:true, command:'hermes update'}` · `uninstall.summary/run → {ok:false}` · `normalizePreviewTarget` → `kind:'url'` targets only, `null` for paths · `watchPreviewFile`/`stopPreviewFileWatch`/`onPreviewFileChanged` inert · `readFileText`, `readDir` → `{error:'unsupported'}` · `sshConfigHosts → {hosts:[]}`, `sshResolveHost → nulls` · `sanitizeWorkspaceCwd → {cwd, sanitized:false}` · `settings.getDefaultProjectDir → {dir:null, defaultLabel:'', resolvedCwd:''}`, `pickDefaultProjectDir → {canceled:true}` · `setActiveWork`, `setTitleBarTheme`, `setTranslucency`, `setDisableF12`, `setPreviewShortcutActive` no-op · `onBackendExit`, `onConnectionApplied`, `onWindowStateChanged`, `onFocusSession`, `onClosePreviewRequested`, `onPreviewNav`, `onOpenFolderRequested`, `onOpenUpdatesRequested` → no-op unsubscribes.

#### D. Omit (typed optional; upstream hides the feature)

`hud`, `wakeIndicator`, `git`, `mcpOauth`, `capturePreview`, `readWindowBelow`, `contextMenu*`, `watchDirectory`, `gitRoot`, `revealPath`, `openDir`, `desktopPluginsRoot`, `agentPluginsRoot`, `readPluginSource`, `renamePath`, `writeTextFile`, `trashPath`, `probePluginRepo`, `installDesktopPlugin`, `reachPreviewUrl`, `openPreviewInBrowser`, `recycleBackend`, `relaunchApp`, `getRemoteDisplayReason`, `connections.updateManaged`, `connections.updateAll`.

Consequence of omitting: the git review pane, worktrees, HUD, pet overlay, disk-loaded desktop plugins, local terminal, and the Electron `<webview>` preview pane do not appear. That is the intended mobile scope; none of them are meaningful without a local filesystem or a second window.

### D5. Authentication

The gateway advertises its capabilities on the public `GET /api/status` as `auth_required`, `auth_providers`, and `auth_flows` (`"cookie"` always when gated; `"native_pkce"` when an interactive provider is registered — `hermes_cli/web_routers/status.py:_auth_gate_status`). Mobile resolves auth as an ordered ladder, exactly as upstream prescribes:

1. **`auth_required:false`** (loopback / trusted host): token mode. Read `window.__HERMES_SESSION_TOKEN__` from `GET /` the way `electron/dashboard-token.ts` does; send `X-Hermes-Session-Token`; WS `?token=`. This is the Phase 0 path (Simulator → gateway on the Mac's loopback).
2. **Password provider, no upstream change (Phase 1).** The gateway's `/auth/password-login` returns the native redirect as **JSON** (`{"ok":true,"next":"<redirect_uri>?code=…&state=…"}`) rather than issuing a 302 (`routes.py:359`). Mobile therefore runs the existing native PKCE broker end-to-end without ever opening a loopback listener:
   1. `GET /auth/native/authorize?provider=basic&code_challenge=<S256>&code_challenge_method=S256&redirect_uri=http://127.0.0.1:1/hermes-mobile&state=<s>` — passes `_validate_loopback_redirect_uri`; the gateway 302s to `/login` and sets its PKCE cookie carrying `broker_state`. `CapacitorHttp` follows the redirect and stores the cookie natively.
   2. `POST /auth/password-login` `{provider, username, password}` — the gateway sees `broker` in the PKCE cookie, verifies credentials, mints the one-time code, and returns it inside `next`. No session cookies are set on this path (by design, `routes.py:_complete_login`).
   3. Parse `code`/`state` from `next`, verify `state`, `POST /auth/native/token {code, code_verifier}` → `{access_token, refresh_token, expires_at, provider, user_id}`.
   4. Store in Keychain (`@aparajita/capacitor-secure-storage` or `capacitor-secure-storage-plugin`), keyed by normalized base URL, mirroring `electron/native-token-store.ts`. Refresh at `/auth/native/refresh` (single-flight, before expiry and on 401). REST uses `Authorization: Bearer`; WS uses `/api/auth/ws-ticket`.
   The `redirect_uri` is a placebo that satisfies the validator; it is never dereferenced. Mobile's login form is a small native-feeling sheet rendered by the bridge (not upstream UI) because upstream's `oauthLoginConnectionConfig` expects Electron to own the browser.
3. **OAuth / OIDC providers incl. Nous Portal (Phase 2) — requires the upstream PR.** The IDP redirects through the gateway's `/auth/callback`, which 302s the *browser* to `redirect_uri`. That must be a URI iOS routes to the app. See "The upstream PR" below. Once merged, mobile feature-detects `"native_pkce_app_redirect"` in `auth_flows` and uses `ASWebAuthenticationSession` (Capacitor `@capacitor/browser` + `App.appUrlOpen`, or a small custom plugin) with `redirect_uri=com.hermesmobile.app:/oauth2redirect`. Older gateways fall to rung 2 or a "this gateway needs Hermes ≥ X for OAuth on mobile" message — never a silent failure.

Hermes Cloud (`cloud.*`, Privy session in a partition) is Phase 2 and rides the same rung-3 mechanism.

### D6. Responsive / adaptive UI

Upstream already has the important seam: `SIDEBAR_COLLAPSE_MEDIA_QUERY = (max-width: 639.98px)` (`app/layout-constants.ts`) undocks both rails into overlays, and `PAGE_INSET_X` uses `clamp()` gutters. Mobile does **not** fork any component. One stylesheet, `src/styles/mobile.css`, loaded after upstream's `styles.css`, scoped under `html[data-hermes-host="mobile"]` (attribute set by the bridge), covers:

| Concern | Treatment |
|---|---|
| Safe areas | `viewport-fit=cover`; padding from `env(safe-area-inset-*)` on the app shell, composer, and overlay rails. |
| Keyboard | Capacitor `Keyboard` with `resize: 'native'`; composer uses `100dvh` (upstream already uses `dvh` in three places). |
| Touch targets | Minimum 44 pt on sidebar rows, composer buttons, settings toggles via `[data-hermes-host="mobile"] :is(button, [role=button])` rules with `@media (pointer: coarse)`. |
| Hover-reveal controls | Upstream overrides Tailwind's `hover` variant to plain `&:hover` (`@custom-variant hover (&:hover)` in `styles.css`), which makes hover-revealed controls invisible-but-clickable on touch. `@media (hover: none)` forces `opacity:1` on those groups. |
| iOS input zoom | `font-size: 16px` floor on inputs/textarea. |
| Window chrome | Titlebar drag regions (`-webkit-app-region`) neutralised; window controls already hide because `windowButtonPosition:null` / `nativeOverlayWidth:0`. |
| Rail reveal on touch | Upstream's <640 px mode reveals rails on hover at the edge. Mobile adds an edge-swipe (Phase 1) and relies on the existing toggle buttons (Phase 0). |
| Scroll | `overscroll-behavior: none` on the shell; `-webkit-overflow-scrolling` defaults are fine on iOS 17+. |

What auto-hides with no CSS at all: everything in D4 §D (git, HUD, pet, terminal, plugins-from-disk, `<webview>` preview pane), plus any Settings section gated on an optional bridge method (`updates`, `uninstall`, `quickEntry`, `translucency`, local models).

### D7. Phases

**Phase 0 — Spike (target: 1 week). Exit criteria, all testable:**

1. `git submodule add` at the pin; `npm ci` in `upstream/` succeeds on a clean macOS clone with the same Node range upstream declares (`^22.22 || ^24.11 || >=26`).
2. `npm run build` (mobile) produces `dist/` using the merged Vite config with **no mobile-declared aliases** for `@`, `@hermes/*`.
3. `tsc --noEmit` passes with the bridge object declared `satisfies Window['hermesDesktop']` against upstream's `global.d.ts`.
4. Playwright **WebKit** loads `vite preview` against a real `hermes dashboard` gateway (token mode) whose model provider is upstream's `e2e/mock-server.ts` OpenAI-compatible mock inference server — the same no-API-key chain `scripts/dev-mock.mjs` sets up: boot overlay dismisses, a session is created, a prompt returns the canned reply, and the settings overlay opens. Zero uncaught exceptions in the console.
5. iOS Simulator (Capacitor) connects to a real `hermes dashboard` on the Mac's loopback in token mode; sends a prompt; receives a streamed reply; survives background → foreground (App `resume` → reconnect) without a manual reload.
6. At 390 × 844 the sidebar can be opened and closed by touch, the composer stays above the keyboard, and no element is hidden under the notch/home indicator.
7. `scripts/scan-bridge-usage.mjs` runs in CI and its manifest lists every non-optional bridge method with a status (`impl`/`stub`/`omit`).

**Phase 1 — Usable daily driver (3–4 weeks).** Password-provider auth (D5 rung 2) with Keychain storage; v2 connection registry through upstream's Settings → Gateway UI; photo/file attach; Share-sheet saves; local notifications for turn completion; power/battery signals; `mobile.css` pass on chat, sidebar, settings, model picker, command palette; edge-swipe rails; TestFlight build; the parity suite (D8) on every PR and weekly against upstream `main`.

**Phase 2 — Native integration (3–4 weeks, partly gated on the upstream PR).** System-browser OAuth (`ASWebAuthenticationSession`) + Hermes Cloud sign-in behind `auth_flows` detection; `hermes://` deep links; Share Extension ("send to Hermes" text/URL/image into a session); haptics via Capacitor `Haptics` (upstream's `HapticsProvider` uses `web-haptics`, an AudioContext-driven technique that does not reach the Taptic Engine; the bridge registers a native trigger through `@/lib/haptics`' `registerHapticTrigger` seam); voice input through `requestMicrophoneAccess` + the gateway transcription API; theme marketplace fetch; iPad layout (>640 px docks rails natively already).

**Phase 3 — Breadth and handoff.** Android build (Capacitor makes it mostly configuration); App Store / Play submission; proposal to Nous to adopt as `apps/mobile/` (D9).

### D8. Parity and drift detection

Upstream moves ~20 commits/day. The suite that keeps us honest, run on every PR and by a weekly `bump-upstream` GitHub Action that opens a PR moving the pin to upstream `main`:

1. **Compile-time contract.** `src/bridge/index.ts` ends with `export const bridge = {...} satisfies Window['hermesDesktop']`. Any new *required* method upstream fails `tsc` in the bump PR with the exact name.
2. **Usage scan.** `scripts/scan-bridge-usage.mjs` greps `upstream/apps/desktop/src` (non-test) for `window.hermesDesktop.<x>` (non-optional) and `window.hermesDesktop?.<x>` (optional), diffs against `src/bridge/manifest.json`, and fails on any method that is neither implemented, stubbed, nor explicitly omitted. The bump PR body includes the diff.
3. **Structural touchpoints.** `tests/upstream-touchpoints.test.ts` snapshots the SHA-256 of the few upstream files mobile *copies or structurally depends on*: `index.html`, `main.tsx` (mount contract), `vite.config.ts` (export shape), `layout-constants.ts` (collapse query), `global.d.ts`. A change forces a human look; it does not block.
4. **WebKit smoke.** Phase 0 criterion 4, kept green forever: real gateway + mock inference, boot, prompt, settings. Playwright WebKit ≈ WKWebView. CI installs the Python gateway from the same submodule pin, so the smoke also catches renderer/gateway API skew.
5. **Auth ladder tests.** Fixtures for `auth_flows: []`, `["cookie"]`, `["cookie","native_pkce"]`, and `["cookie","native_pkce","native_pkce_app_redirect"]` assert which rung mobile selects.
6. **Release pin discipline.** A mobile release is tagged `v<mobile>+hermes.<sha7>`; the bridge manifest is committed alongside.

### D9. Handoff to Nous Research

Because mobile carries no patches to upstream source, adoption is a directory move: `upstream/apps/desktop` → `../desktop`, `@upstream` → `@/`, and the submodule disappears. The bridge, `mobile.css`, the scan script, and the WebKit smoke test all survive unchanged. If Nous ships their own mobile client instead, this repository archives with a pointer and a written list of the bridge/CSS findings; the auth work (D5) and the redirect-URI PR benefit any client.

## The one upstream PR: app-scheme redirect URIs for the native flow

**File:** `hermes_cli/dashboard_auth/routes.py`, function `_validate_loopback_redirect_uri` (line 215 at the pin). Today:

```python
def _validate_loopback_redirect_uri(raw: str) -> str:
    """Accept only ``http://127.0.0.1[:port]/…`` / ``http://[::1][:port]/…``. ..."""
    if not raw:
        raise _http(400, "redirect_uri required")
    parsed = urlparse(raw)
    if parsed.scheme != "http":
        raise _http(400, "native redirect_uri must be http:// on the loopback interface")
    if (parsed.hostname or "").lower() not in ("127.0.0.1", "::1"):
        raise _http(400, "native redirect_uri host must be a loopback IP literal (127.0.0.1 / ::1)")
    return raw
```

**Change (RFC 8252 §7.1 private-use URI schemes, opt-in):**

1. Rename to `_validate_native_redirect_uri`. Keep the loopback branch byte-for-byte. Add a second accepted form: a **private-use scheme** that (a) contains a `.` (reverse-DNS, e.g. `com.hermesmobile.app:/oauth2redirect`), (b) is not `http`/`https`/`javascript`/`data`/`file`, (c) has no host component beyond the scheme's path, and (d) is listed in a new `dashboard.native_redirect_schemes: [...]` config array (or `HERMES_DASHBOARD_NATIVE_REDIRECT_SCHEMES`, comma-separated). Empty list ⇒ current behaviour, so the default deployment is unchanged. `localhost` stays rejected.
2. `hermes_cli/dashboard_auth/native_flow.py`: no logic change; update the `_Pending.redirect_uri` comment ("loopback or registered app scheme").
3. `hermes_cli/web_routers/status.py::_auth_gate_status`: append `"native_pkce_app_redirect"` to `auth_flows` when the scheme list is non-empty, so clients feature-detect instead of probing.
4. Tests in `tests/hermes_cli/test_dashboard_auth_native_flow.py`: accepted registered scheme; rejected unregistered scheme; rejected `https://evil.example/cb`; rejected `localhost`; `auth_flows` advertisement toggles with config.
5. Docs: one paragraph in the dashboard-auth docs explaining that the scheme allowlist is the security boundary (an open allowlist would turn `/auth/native/authorize` into an open redirect leaking a live code — the same reason the function exists).

This is a ~40-line, additive, default-off change consistent with the file's existing security posture. Mobile never *depends* on it for Phase 0–1.

## Consequences

**Positive**

- Upstream UI, settings, i18n, themes, plugins-SDK, and gateway API helpers arrive on mobile by moving one submodule pointer. The weekly bump PR is the entire maintenance loop.
- No fork, no patches: every mobile need that touches upstream becomes an upstream PR, which is also how the project stays legible to Nous.
- The bridge is host-agnostic. The same `src/bridge` could back a PWA served by the gateway, a Tauri shell, or an Android build.
- Auth reuses the gateway's audited native flow; mobile adds no new token format or server route for Phase 1.

**Negative / accepted**

- We ship the whole desktop bundle (mermaid, shiki, katex, xterm) to a phone. Upstream's `advancedChunks` keep these lazy; first-launch parse cost must be measured in Phase 0 (criterion 5) and is the first candidate for a targeted alias if unacceptable.
- iOS cannot host a local gateway. Mobile is remote-only; the first-run experience is "enter your gateway URL", and the install/bootstrap overlay is permanently inert.
- The mobile UX is "desktop at 390 px, made touchable", not a ground-up phone design. That is the trade for zero-drift. A native-feeling composer or tab bar would be a Phase 3 discussion — and would still be built *around* the upstream tree, never inside it.
- Every bump can break us. The suite in D8 converts that from surprise to a labelled PR.

## Known risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| WKWebView incompatibility in a heavy dependency (xterm WebGL addon, `web-haptics`, `frimousse` emoji fetch, `use-stick-to-bottom`) | Medium | Phase 0 criterion 4/5; all are behind lazy imports or bridge-gated features. Emoji data already served locally by the inherited Vite plugin. |
| Tailwind v4 source scanning walks the entire `upstream/` tree (Python, docs) | High (perf only) | Add `@source "../../upstream/apps/desktop/src"` and `@source not "../../upstream/**"` in `mobile.css` if build time exceeds ~30 s. |
| Upstream adds a required bridge method mid-boot path | Certain, over time | D8 items 1–2 fail the bump PR with the method name. Stub-first policy: a new method gets a well-formed failure stub the same day, a real implementation when it matters. |
| Upstream switches bundler or drops the function-form `vite.config.ts` | Low | `vite.config.ts` has 3 commits in 90 days. `mergeConfig` handles object or function; a bundler swap would be a deliberate, announced change and a real re-plan. |
| Cookie handling for the PKCE cookie between `authorize` → `password-login` | Medium | `CapacitorHttp` uses URLSession's shared cookie storage; the cookie is set on the 302 and sent on the POST. Fallback: read `Set-Cookie` from the 302 with `disableRedirects: true` and forward it explicitly. Tested in Phase 1 against the `basic` plugin. |
| `Secure` cookie flag over plain-http Tailscale | Low | Gateway uses `detect_https(request)`; over http the flag is off. Document that https or Tailscale-http both work; `localhost` does not (RFC 8252 §8.3, upstream rule). |
| Hermes Cloud / OAuth unusable until the upstream PR merges | Certain for Phase 2 timing | Phase 1 is fully useful with the `basic` password provider. Ladder message tells the user the exact gateway version needed. |
| `capacitor.config.ts` or plugin wiring overwritten by `cap sync` | Known from prior projects | Config lives in the committed `capacitor.config.ts` at repo root; `npm run sync` wraps `cap sync` and re-asserts custom plugin registration. |
| Apple Developer Program required for device builds/TestFlight | Certain | Simulator suffices through Phase 0; Program enrolment is a Phase 1 prerequisite. |
| Nous ships an official mobile app | Possible | D9. The work is designed to be absorbed or retired gracefully. |

## References (paths relative to `upstream/` at `f159e581c7`)

- Bridge contract: `apps/desktop/src/global.d.ts` · Electron implementation: `apps/desktop/electron/preload.ts`, `main.ts` (`hermes:api`, `hermes:gateway:ws-url`)
- Renderer entry and boot: `apps/desktop/src/main.tsx`, `src/app/gateway/hooks/use-gateway-boot.ts`, `src/store/boot.ts`
- Transport: `apps/desktop/src/api/client.ts`, `apps/shared/src/websocket-url.ts`, `apps/shared/src/json-rpc-gateway.ts`, `apps/desktop/electron/api-transport.ts`, `electron/dashboard-token.ts`
- Native auth: `hermes_cli/dashboard_auth/routes.py`, `native_flow.py`, `plugins/dashboard_auth/basic/__init__.py`, `hermes_cli/web_routers/status.py`, `apps/desktop/electron/native-oauth.ts`, `native-token-store.ts`
- Layout seams: `apps/desktop/src/app/layout-constants.ts`, `src/store/layout.ts`, `src/styles.css`
- Contribution contract: `apps/desktop/AGENTS.md` ("Cross everything as an observable ladder")
- Existing parity pattern: `apps/desktop/src/hermes-parity.test.ts`; no-API-key test chain (real gateway + mock inference): `apps/desktop/e2e/mock-server.ts`, `apps/desktop/scripts/dev-mock.mjs`
