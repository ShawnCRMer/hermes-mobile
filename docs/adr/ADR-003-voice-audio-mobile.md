# ADR-003: Voice and audio on iOS, and the on-device bar's activity guard

| | |
|---|---|
| **Status** | Proposed — execution-ready |
| **Date** | 2026-09-09 |
| **Extends** | [ADR-001](./ADR-001-mobile-architecture.md) (bridge pattern, zero upstream patches), [ADR-002](./ADR-002-local-gateway.md) (embedded gateway, `local-connection.ts`) |
| **Upstream pin analysed** | `NousResearch/hermes-agent` @ `f159e581c7` (desktop `0.17.0`, gateway `0.21.0`) |
| **Evidence** | Measured inside the real Capacitor `WKWebView` on the iPhone 17 Pro / iOS 26.5 Simulator (reproduction in the Appendix); every other claim is a file:line citation into `upstream/`, `src/`, `ios/`, or `node_modules/@capacitor/ios` |

## Context

Three voice reports against the phone connected to a remote gateway ("Luna"), plus one shell bug:

1. **Dictation** (mic item in the composer's voice menu) — toast *"Voice recording failed — This runtime does not support microphone recording."*
2. **Speaker** ("Speak replies" toggle) — toast *"Autosave failed"*.
3. **Ear** ("Hey Hermes" wake-word toggle) — does nothing visible.
4. **`LocalModelBar`** renders at the top of the chat pane while the active connection is the remote gateway. A first fix gated it on `localPhase === 'ready'`; this ADR shows why that gate cannot work and replaces it.

`CLAUDE.md` currently records voice input as *"verified complete, no additional work needed"* (line 113). That statement was made from reading the API surface, not from running the WebView. It is wrong, and this ADR corrects it with measurements.

Nothing in this ADR patches upstream. Every change is in the mobile shell, the bridge, or the Xcode project.

## Investigation

### 1. How upstream voice works end-to-end

All voice UI lives in one hook tree under the composer. The relevant files and what each needs from the runtime:

| Feature | Upstream code | Browser APIs it calls | Gateway calls (through `window.hermesDesktop.api` unless noted) |
|---|---|---|---|
| **Dictation** (push-to-talk → draft) | `composer/hooks/use-voice-recorder.ts` → `use-mic-recorder.ts` | `navigator.mediaDevices.getUserMedia({audio})`, `MediaRecorder` (first supported of `audio/webm;codecs=opus`, `audio/webm`, `audio/mp4`, …), `AudioContext` + `AnalyserNode` for the level meter, `requestAnimationFrame` | `POST /api/audio/transcribe` `{data_url, mime_type}` (`api/system.ts:171`), optionally preceded by `GET /api/audio/voice-config` and a **direct `fetch()` to the STT provider** (`lib/voice-client-direct.ts:180`) |
| **Speak replies** (auto-TTS toggle) | `use-composer-voice.ts:298` `handleToggleAutoSpeak` → `store/voice-prefs.ts:56` `setAutoSpeakReplies` | — | `GET /api/config` then **`PUT /api/config` `{config}`** (`api/config.ts:93`); on failure the toast is `t.settings.config.autosaveFailed` = *"Autosave failed"* (`i18n/en.ts:725`). While on, `lib/tts-lease.ts` also does `POST /api/audio/tts-lease` |
| **Reply playback** | `use-auto-speak-replies.ts` → `lib/voice-playback.ts:655` `playSpeechText` | `new Audio(dataUrl).play()`, `WebSocket`, `AudioContext.createBufferSource` (PCM scheduling) | Ladder: client-direct provider `fetch()` → `ws(s)://…/api/audio/speak-stream` (renderer opens the socket itself, `voice-playback.ts:108-181`) → `POST /api/audio/speak` (base64 data URL) |
| **Voice conversation** ("Start voice chat") | `use-voice-conversation.ts` | Everything above, plus `lib/voice-barge-in.ts` which holds a second `getUserMedia` stream + `MediaRecorder` for the whole turn, and `lib/thinking-sound.ts` (`OscillatorNode`) | `wake.pause`/`wake.resume` RPC over the chat WebSocket, transcribe/speak as above |
| **Ear / wake word** | `composer/voice-menu.tsx:146-158` → `store/wake-word.ts:289` `toggleWakeWord` | When the gateway answers `capture: client` (headless host, no PortAudio mic — exactly Luna's situation): `lib/wake-client-capture.ts` opens `getUserMedia`, downsamples to 16 kHz int16 via `ScriptProcessorNode`, and streams frames | `wake.status` / `wake.start {client_capture:true, persist:true}` / `wake.feed {pcm}` / `wake.stop` JSON-RPC over the chat WebSocket. Availability is decided server-side (`upstream/tools/wake_word.py:380-420`): STT + TTS configured, wake engine deps installed, Porcupine key if that provider |

The composer's menu is one `VoiceMenu` (`voice-menu.tsx`) on narrow layouts (`controls.tsx:86` `foldedVoice`), so all three reports come from the same trigger button.

Precheck that produced report 1 — `use-mic-recorder.ts:174-176`:

```ts
if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
  throw new Error(copy.microphoneUnsupported)   // "This runtime does not support microphone recording."
}
const permitted = await window.hermesDesktop?.requestMicrophoneAccess?.()
```

So the bridge's `requestMicrophoneAccess` (`src/bridge/index.ts:883`) is **never reached** in the failing state. The failure is decided by the WebView's globals before any bridge code runs.

### 2. What the Capacitor WKWebView actually provides (measured)

I copied the existing simulator build (`DerivedData/App-*/Build/Products/Debug-iphonesimulator/App.app`), injected a probe `<script>` into `public/index.html`, installed it on the iPhone 17 Pro simulator, and read Capacitor's console relay via `xcrun simctl launch --console-pty`. Two runs: the app exactly as built today, then the same bundle with one Info.plist key added.

| Probe (`capacitor://localhost`, WebKit 605.1.15) | As shipped today | + `NSMicrophoneUsageDescription` |
|---|---|---|
| `window.isSecureContext` | `true` | `true` |
| `typeof MediaRecorder` | `"function"` | `"function"` |
| `MediaRecorder.isTypeSupported` webm/opus · webm · mp4 · ogg · wav | true · true · true · false · false | same |
| `typeof AudioContext` / `speechSynthesis` / `webkitSpeechRecognition` | function / object / function | same |
| **`navigator.mediaDevices`** | **`undefined`** | **defined**, `getUserMedia` present |
| `getUserMedia({audio:{echoCancellation,noiseSuppression}})` | not callable | resolves, 1 audio track |
| `new MediaRecorder(stream)` → `start()` → `stop()` after 1.5 s | — | `audio/webm;codecs=opus`, 1 chunk, **44 015 bytes** |

Conclusions that follow directly:

- The origin is a secure context, `MediaRecorder` exists and prefers the same `audio/webm;codecs=opus` type the desktop produces, so the gateway's `/api/audio/transcribe` (`hermes_cli/web_routers/audio.py:77`, accepts any `audio/*`, 25 MB cap) receives exactly what it receives from Electron.
- The **only** missing piece for capture is `navigator.mediaDevices`, and WebKit withholds it when the host app's bundle has no microphone usage description. `ios/App/App/Info.plist` has no `NSMicrophoneUsageDescription` (checked with `PlistBuddy`; the file's only privacy-adjacent key is `NSAppTransportSecurity`).
- Capacitor already grants WebKit's per-origin capture prompt (`node_modules/@capacitor/ios/Capacitor/Capacitor/WebViewDelegationHandler.swift:50-58` answers `requestMediaCapturePermissionFor` with `.grant`) and already relaxes the autoplay policy (`CAPBridgeViewController.swift:122-125`: `allowsInlineMediaPlayback = true`, `mediaTypesRequiringUserActionForPlayback = []`), so `Audio.play()` and `AudioContext` started from a WebSocket callback (no user gesture — `voice-playback.ts:473`) are not blocked. No Swift is needed.

### 3. Finding: native JSON request bodies are silently dropped ("Autosave failed")

`setAutoSpeakReplies` does `GET /api/config` (works — GET) then `PUT /api/config` with body `{config}`. On native the bridge sends it through `nativeRequest` (`src/bridge/index.ts:326-342`):

```ts
const response = await CapacitorHttp.request({
  url, method: input.method ?? 'GET', headers, data: input.body, responseType: 'text', …
})
```

`headers` at that point holds only the auth header (`applyAuth`, line 344-355). **No `Content-Type`.** Capacitor's iOS HTTP plugin only attaches a body when that header exists — `node_modules/@capacitor/ios/Capacitor/Capacitor/Plugins/CapacitorUrlRequest.swift:215-221`:

```swift
public func setRequestBody(_ body: JSValue, _ dataType: String? = nil) throws {
    let contentType = self.getRequestHeader("Content-Type") as? String
    if contentType != nil {
        request.httpBody = try getRequestData(body, contentType!, dataType)
    }
}
```

So every native `POST`/`PUT` with a JSON body reaches FastAPI **with no body at all**. `PUT /api/config` (`hermes_cli/web_routers/config_env.py:109`, pydantic `ConfigUpdate`) answers **422**, `executeRequest` throws `"422: {...}"` (line 387-388), `setAutoSpeakReplies` reverts the atom and rethrows, and the composer shows *"Autosave failed"*. That is report 2, and it is not voice-specific:

- Same path, same failure: `POST /api/audio/transcribe`, `POST /api/audio/speak`, `POST /api/audio/tts-lease`, and **every Settings autosave** on a remote connection (`appearance-settings.tsx:95`, `terminal-font-setting.tsx:112`, `config-settings.tsx:233`, `voice-provider-fields.tsx:69` all toast the same string).
- The browser path is correct (`browserRequest`, line 311-313 sets `Content-Type: application/json`), which is why the Playwright WebKit smoke suite never sees this — it runs the browser branch.
- The **local-mode** path is also correct (`src/bridge/local-connection.ts:253-256` sets the header), which is why config writes work on the embedded gateway and fail on Luna.
- `auth.ts:151,209` and `vscode-marketplace.ts:19` each set the header by hand for their own `CapacitorHttp` calls; `nativeRequest` is the one generic call site that forgot.

### 4. Finding: the ear needs the same plist key, then depends on the gateway

`wake-client-capture.ts:94-96` throws *"getUserMedia unavailable for client wake capture"* when `navigator.mediaDevices` is missing; `store/wake-word.ts:64-79` catches it, sets `listening:false`, stores the message as the tooltip `notice`, and best-effort sends `wake.stop`. The toggle flips back off with no toast — "does nothing" from the user's seat.

After the plist fix the phone-side chain is complete (`getUserMedia` → `ScriptProcessorNode` → `wake.feed`). What remains is entirely gateway-side and is the same on desktop: `wake.status.available` requires STT and TTS configured, the wake engine installed (`openwakeword`/`onnxruntime`, lazily installed on first `wake.start`, hence upstream's 180 s timeout), and `wake_word.capture` resolving to `client` on a mic-less host (`tools/wake_word.py:403-410` emits the exact hint). The mobile shell must not try to hide this; upstream deliberately keeps the ear always mounted and surfaces the reason in the tooltip (`controls.tsx:353-359`).

Mobile-specific limit to state plainly: WKWebView capture and the `ScriptProcessorNode` graph stop when the app leaves the foreground. The ear listens while Hermes is on screen — same as the Screen Wake Lock already used by `setKeepAwake`. Background wake-word is a native-audio project (AVAudioEngine + `UIBackgroundModes: audio`) and is out of scope here.

### 5. Finding (Issue 2): `localGatewayReady` overrides the routing flag

Two truths exist for "is local mode on":

- **Routing truth** — `isLocalEnabled()` (`src/bridge/local-connection.ts:52-60`, localStorage `hermes-mobile.local.enabled`, default *on* for a fresh native install). Every bridge route consults it: `getConnection` (index.ts:529), `getGatewayWsUrl` (559), `api` (854), `getBootProgress` (622), `getConnectionConfig` (624), `onPowerResume` (1060), plus `network.ts:13`. `saveConnectionConfig({mode:'remote'})` writes it to `'0'` (index.ts:643).
- **UI mirror** — `localState.enabled`, pushed to `onLocalProgress` subscribers and mirrored onto `html[data-local-mode]` (`updateLocalState`, line 81-89). `LocalModelBar`, `SettingsTab.activeConnectionId` (settings-tab.tsx:100) and the CSS rule that hides upstream's model pill (mobile.css:881) all read this mirror.

They diverge on every launch. `AppDelegate.startLocalModeIfEnabled()` (`ios/App/App/AppDelegate.swift:59-62`) starts `PythonRuntime` **unconditionally**; `LocalGatewayPlugin.pushProgress` (`ios/App/Sources/HermesGateway/LocalGatewayPlugin.swift:42-50`) emits `localGatewayReady` when it boots; and the JS listener (`local-connection.ts:227-235`) handles it with:

```ts
updateLocalState({ phase: 'ready', progress: 100, port: …, token: …, enabled: true })
```

`enabled: true`, unconditionally. Seconds after launch on Luna the mirror says local is on, `data-local-mode` appears, the Settings tab highlights "On-device", and `LocalModelBar` renders — while every request still routes to Luna. The `localPhase === 'ready'` guard is exactly the condition that is *true* in the bug: the embedded gateway is ready, it simply is not the selected connection. The initial `getState()` handler (line 206-212) already does it right (`enabled: state.available && isLocalEnabled()`); the ready handler must match.

### 6. What needs no work (and why)

- `MediaRecorder`, `AudioContext`, `Audio`, WebSocket audio streaming — present and unblocked (Section 2).
- `/api/audio/speak-stream` — the renderer builds the URL from `getConnectionFor`/`getGatewayWsUrlFor` (`voice-playback.ts:134-159`), both `impl` in the manifest, and the resulting `ws://` socket is the same transport the chat socket already uses on Luna.
- Bridge manifest — no new methods; `requestMicrophoneAccess` stays `impl`.
- Upstream — untouched (ADR-001 D1).

### 7. Risks noted for the device test, not fixed here

- **Client-direct provider `fetch()` from `capacitor://localhost`.** `voice-client-direct.ts` calls OpenAI/Groq/ElevenLabs/xAI straight from the renderer when the gateway reports `mode: 'direct'`. A CORS refusal surfaces as a `TypeError` that `transcribeAudioClientDirect` does **not** catch (line 180-267), so dictation would fail without falling back to the relay. The providers upstream ships this for are CORS-open (Electron enforces CORS too), so it is expected to work; if it does not, the gateway-side switch is `voice.client_direct: false` (`tools/voice_client_config.py:10,33-39`) and no mobile code changes.
- **Foreground-only capture** (Section 4). Voice conversation and the ear pause when the screen locks. Acceptable for this ADR.
- **Speaker playback when backgrounded** stops without `UIBackgroundModes: audio`. Deferred; not part of the reports.

## Decision

- **D1.** Declare `NSMicrophoneUsageDescription` in `ios/App/App/Info.plist`. This is the sole capture fix; no Capacitor plugin, no Swift.
- **D2.** `nativeRequest` sets `Content-Type: application/json` and pre-serialises `input.body` with `JSON.stringify`, so native and browser branches put identical bytes on the wire. This fixes "Autosave failed" and unblocks transcribe / speak / tts-lease / every settings autosave on remote.
- **D3.** `requestMicrophoneAccess` memoises a successful grant so the second `getUserMedia` upstream performs is not preceded by a redundant open/close of the capture device on every dictation. (iOS terminates the app when the user revokes a privacy permission, so the memo cannot go stale.)
- **D4.** `localGatewayReady` mirrors `isLocalEnabled()` instead of forcing `enabled: true`; `LocalModelBar` renders only when `isLocalEnabled() && state.enabled && phase === 'ready'`. The Settings tab and the model-pill CSS inherit the fix through the mirror.
- **D5.** Static guards in `tests/bridge-contract.test.mjs` pin all four so a `cap sync`, a Capacitor bump, or a refactor cannot silently regress them. `CLAUDE.md` line 113 is corrected.

## Implementation plan

Every step is a literal edit. Paths are repo-relative from `/Users/shawnrupp/hermes-mobile`. Line numbers refer to the files as of this ADR.

### Step 1 — Info.plist: microphone usage description (D1)

File: `ios/App/App/Info.plist`. Insert immediately before the final `</dict>` (currently line 66, right after the `NSAppTransportSecurity` block that ends on line 65):

```xml
	<key>NSMicrophoneUsageDescription</key>
	<string>Hermes uses the microphone for voice dictation, voice conversations, and the “Hey Hermes” wake word.</string>
```

Resulting tail of the file:

```xml
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
	<key>NSMicrophoneUsageDescription</key>
	<string>Hermes uses the microphone for voice dictation, voice conversations, and the “Hey Hermes” wake word.</string>
</dict>
</plist>
```

Notes: the App target uses `INFOPLIST_FILE = App/Info.plist` (`ios/App/App.xcodeproj/project.pbxproj:501,526`), not generated Info.plist, so the edit is the whole change. `cap sync` does not rewrite Info.plist. Do **not** add a camera key — upstream only requests `{ audio: … }`.

### Step 2 — bridge: JSON bodies on native requests (D2)

File: `src/bridge/index.ts`, replace the whole `nativeRequest` function (lines 326-342):

```ts
async function nativeRequest(
  url: string,
  input: HermesApiRequest,
  headers: Record<string, string>,
): Promise<HttpResult> {
  if (input.upload) throw new Error('Multipart uploads are not available in the Phase 0 mobile bridge.')
  // CapacitorHttp on iOS (CapacitorUrlRequest.setRequestBody) attaches `data`
  // ONLY when a Content-Type header is present; otherwise the request leaves
  // with no body and FastAPI answers 422 — the "Autosave failed" toast on
  // every JSON PUT/POST (config, audio/transcribe, audio/speak, tts-lease).
  // Pre-serialise so the wire bytes match browserRequest() exactly (ADR-003).
  let data: string | undefined
  if (input.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    data = JSON.stringify(input.body)
  }
  const response = await CapacitorHttp.request({
    url,
    method: input.method ?? 'GET',
    headers,
    ...(data !== undefined ? { data } : {}),
    responseType: 'text',
    connectTimeout: input.timeoutMs,
    readTimeout: input.timeoutMs,
  })
  return { data: response.data, headers: response.headers, status: response.status }
}
```

Why a string and not the object: `getRequestData` (`CapacitorUrlRequest.swift:174-195`) sends a string body verbatim and only JSON-serialises objects through `JSONSerialization`, which does not guarantee key order or number formatting identical to `JSON.stringify`. A pre-serialised string keeps the multi-megabyte transcribe data URL out of the plugin's re-serialisation and keeps native and browser payloads byte-identical.

The 401-refresh retry at line 377-379 passes `retryHeaders` into the same function, so it is covered without further edits.

### Step 3 — bridge: memoise microphone grant (D3)

File: `src/bridge/index.ts`.

3a. Add one module-level flag next to the other module state (after line 66, `const DEFAULT_POOL_LIMITS = …`):

```ts
// Set once getUserMedia has resolved this process; iOS relaunches the app when
// the user changes the mic permission, so a stale true is impossible.
let microphoneGranted = false
```

3b. Replace `requestMicrophoneAccess` (lines 883-888) with:

```ts
  async requestMicrophoneAccess() {
    // WKWebView withholds navigator.mediaDevices entirely unless the app
    // bundle declares NSMicrophoneUsageDescription (measured — ADR-003 §2).
    // Upstream's use-mic-recorder checks the same global before calling us.
    if (!navigator.mediaDevices?.getUserMedia) return false
    if (microphoneGranted) return true
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach(track => track.stop())
    microphoneGranted = true
    return true
  },
```

Behaviour is unchanged on first use (a rejection still propagates, and upstream reports it through `notifyError(error, recordingFailed)`); subsequent dictations skip the probe open/close.

### Step 4 — local-connection: never force `enabled` from the ready event (D4)

File: `src/bridge/local-connection.ts`, replace the `localGatewayReady` listener (lines 227-235):

```ts
    await LocalGatewayNative.addListener('localGatewayReady', (data: Record<string, unknown>) => {
      // The embedded gateway boots on EVERY launch (AppDelegate.startLocalModeIfEnabled
      // is unconditional), so "ready" says nothing about which connection the
      // user selected. `enabled` is the UI mirror of the routing flag every
      // bridge route consults (isLocalEnabled) — mirror it, never force it (ADR-003 §5).
      updateLocalState({
        phase: 'ready',
        progress: 100,
        port: Number(data.port ?? 0),
        token: String(data.token ?? ''),
        enabled: localModeAvailable && isLocalEnabled(),
      })
    })
```

No other line changes: `updateLocalState` already derives `html[data-local-mode]` from `localState.enabled`, `setLocalEnabled` already writes both stores, and the initial `getState()` handler already uses the same expression.

### Step 5 — `LocalModelBar`: gate on the routing truth (D4)

File: `src/shell/local-model-bar.tsx`. Replace the entire file:

```tsx
import { useState, useEffect, memo } from 'react'
import {
  getLocalState,
  isLocalEnabled,
  onLocalProgress,
  type LocalGatewayState,
} from '../bridge/local-connection'
import { getOnDeviceStatus, onModelStatusChanged } from '../bridge/model-manager'
import { openSheet as openModelManager } from '../bridge/model-manager-ui'

/**
 * The bar belongs to the on-device gateway. It may appear only when that
 * gateway is BOTH the selected connection — the same localStorage flag
 * bridge.getConnection / bridge.api route on — AND actually serving. Phase
 * alone is not enough: the embedded gateway boots on every launch, so it is
 * "ready" while the user is talking to a remote gateway (ADR-003 §5).
 */
function localIsActive(state: LocalGatewayState): boolean {
  return isLocalEnabled() && state.enabled && state.phase === 'ready'
}

export const LocalModelBar = memo(function LocalModelBar() {
  const [active, setActive] = useState(() => localIsActive(getLocalState()))
  const [activeModel, setActiveModel] = useState<string | null>(null)

  useEffect(() => {
    const refreshModel = () => setActiveModel(getOnDeviceStatus().activeModelId)

    refreshModel()
    setActive(localIsActive(getLocalState()))
    const unsub1 = onLocalProgress(state => setActive(localIsActive(state)))
    const unsub2 = onModelStatusChanged(refreshModel)
    return () => { unsub1(); unsub2() }
  }, [])

  if (!active) return null

  const modelName = activeModel
    ? activeModel.replace(/-4bit$/i, '').replace(/-/g, ' ')
    : null

  return (
    <div className="local-model-bar">
      <div className="local-model-bar__label">
        <span className={`local-model-bar__dot ${modelName ? 'local-model-bar__dot--active' : 'local-model-bar__dot--idle'}`} />
        {modelName ? (
          <span className="local-model-bar__name">{modelName}</span>
        ) : (
          <span>No model loaded</span>
        )}
      </div>
      <button className="local-model-bar__action" onClick={openModelManager}>
        Models
      </button>
    </div>
  )
})
```

Behavioural notes: the dot now means "a model is loaded" (the bar is only rendered when the gateway is ready, so the old `ready` dot was always green). `SettingsTab` needs no edit — its `localOn` comes from the same `state.enabled` that Step 4 fixes. The `toggle-local` action in `model-manager-ui.ts:183` flips the routing flag without a reload; that pre-existing behaviour is unchanged and out of scope.

### Step 6 — static guards (D5)

File: `tests/bridge-contract.test.mjs`. Append at the end of the file:

```js
// ── ADR-003: voice/audio on iOS + on-device bar guard ──────────────────────

const infoPlist = fs.readFileSync(path.join(repo, 'ios/App/App/Info.plist'), 'utf8')
const bridgeSource = fs.readFileSync(path.join(repo, 'src/bridge/index.ts'), 'utf8')
const localConnectionSource = fs.readFileSync(path.join(repo, 'src/bridge/local-connection.ts'), 'utf8')
const localModelBarSource = fs.readFileSync(path.join(repo, 'src/shell/local-model-bar.tsx'), 'utf8')

test('ADR-003: Info.plist declares microphone usage (WKWebView hides navigator.mediaDevices without it)', () => {
  assert.match(infoPlist, /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/)
})

test('ADR-003: nativeRequest sends JSON bodies with a Content-Type (CapacitorHttp drops the body otherwise)', () => {
  const start = bridgeSource.indexOf('async function nativeRequest(')
  const end = bridgeSource.indexOf('async function applyAuth(')
  assert.ok(start > 0 && end > start, 'nativeRequest/applyAuth not found in bridge source')
  const fn = bridgeSource.slice(start, end)
  assert.match(fn, /headers\['Content-Type'\] = 'application\/json'/)
  assert.match(fn, /JSON\.stringify\(input\.body\)/)
  assert.doesNotMatch(fn, /data:\s*input\.body/)
})

test('ADR-003: requestMicrophoneAccess memoises a granted probe', () => {
  assert.match(bridgeSource, /let microphoneGranted = false/)
  assert.match(bridgeSource, /if \(microphoneGranted\) return true/)
})

test('ADR-003: localGatewayReady mirrors isLocalEnabled() instead of forcing local on', () => {
  const start = localConnectionSource.indexOf("addListener('localGatewayReady'")
  assert.ok(start > 0, 'localGatewayReady listener not found')
  const block = localConnectionSource.slice(start, localConnectionSource.indexOf('})\n    })', start))
  assert.doesNotMatch(block, /enabled:\s*true/)
  assert.match(block, /enabled:\s*localModeAvailable && isLocalEnabled\(\)/)
})

test('ADR-003: LocalModelBar renders only when local is the selected AND ready connection', () => {
  assert.match(localModelBarSource, /isLocalEnabled\(\) && state\.enabled && state\.phase === 'ready'/)
  assert.doesNotMatch(localModelBarSource, /setLocalEnabled\(state\.enabled\)/)
})
```

Baseline before this ADR (recorded 2026-09-09): `npm test` = 28 tests, 24 pass; the four failures are pre-existing (`manifest accounts for every required top-level bridge method`, `every manifest method has a valid status`, `Phase 1 methods are implemented`, `core transport methods are implemented`) because those tests still expect the single-column manifest format ADR-002 replaced. `npm run typecheck` has one pre-existing error (`capacitor.config.ts(22,3)`: `packageClassList` not in `CapacitorConfig`). Neither is touched by this ADR; the five new tests must pass and the counts must read 33 tests / 29 pass.

### Step 7 — manifest note and CLAUDE.md correction (D5)

7a. File: `src/bridge/manifest.json`, line 39, replace:

```json
    "requestMicrophoneAccess": { "remote": "impl", "local": "impl" },
```

with:

```json
    "requestMicrophoneAccess": { "remote": "impl", "local": "impl", "note": "needs NSMicrophoneUsageDescription in Info.plist — WKWebView hides navigator.mediaDevices without it (ADR-003)" },
```

(The manifest already carries `note` fields on `localModelsEnabled` and `onDeviceModels`, and `scan-bridge-usage.mjs` validates the two-column format, so this is format-compatible.)

7b. File: `CLAUDE.md`, line 113, replace:

```
11. Voice input — verified complete, no additional work needed. Bridge's `requestMicrophoneAccess` uses `getUserMedia`, upstream's `use-mic-recorder.ts` uses standard `MediaRecorder` API which works in WKWebView.
```

with:

```
11. Voice input — see `docs/adr/ADR-003-voice-audio-mobile.md`. WKWebView hides `navigator.mediaDevices` unless Info.plist declares `NSMicrophoneUsageDescription` (measured); `MediaRecorder` (webm/opus) works. Native JSON request bodies need an explicit `Content-Type` or CapacitorHttp drops them ("Autosave failed").
```

7c. File: `CLAUDE.md`, add a fourth gotcha after the "Capacitor gotcha" section (after line 58):

```
## CapacitorHttp gotcha

`CapacitorHttp` on iOS only attaches `data` when a `Content-Type` header is set (`CapacitorUrlRequest.setRequestBody`). Any new native request with a body must set the header explicitly — `nativeRequest` in `src/bridge/index.ts` does this for JSON; do not bypass it.
```

### Step 8 — build, sync, verify

```bash
cd /Users/shawnrupp/hermes-mobile
npm run typecheck        # expect only the pre-existing capacitor.config.ts error
npm run lint
npm test                 # expect 33 tests, 29 pass (4 pre-existing failures)
npm run build
npx cap sync ios
# CLAUDE.md gotcha: confirm cap sync kept the custom plugin list
grep -c "LocalGatewayPlugin" ios/App/App/capacitor.config.json   # must print 1
# Info.plist is not managed by cap sync; confirm the key survived
/usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" ios/App/App/Info.plist
npx cap open ios         # build to ElTelephono (device) for the voice tests below
```

## Dependencies

| | |
|---|---|
| New Capacitor plugins | **None.** `@capacitor/core` `CapacitorHttp` (already used) and WebKit built-ins cover everything. |
| Swift changes | **None.** Capacitor's `WebViewDelegationHandler` already grants `requestMediaCapturePermissionFor`; `CAPBridgeViewController` already disables the autoplay gesture requirement. |
| Info.plist | `NSMicrophoneUsageDescription` (Step 1). Not required: `NSCameraUsageDescription`, `NSSpeechRecognitionUsageDescription` (upstream does not use `SpeechRecognition`), `UIBackgroundModes`. |
| Entitlements | None. |
| Gateway-side (Luna), user-configured, not code | STT provider (`stt.*` / `voice.*` in Luna's config, or client-direct via `/api/audio/voice-config`); TTS provider for playback; wake-word engine + `wake_word.capture: client` (or `auto`, which resolves to client on a mic-less host) for the ear. |
| Upstream | Unchanged. |

## Testing plan

### T1. Static (every commit)

`npm test` — the five ADR-003 tests pass; `npm run typecheck`, `npm run lint` unchanged apart from the pre-existing `capacitor.config.ts` error.

### T2. Simulator — capability check (no gateway needed)

Build the App scheme to the iPhone 17 Pro simulator, open Safari → Develop → Simulator → Hermes, and evaluate:

```js
({ md: !!navigator.mediaDevices, mr: typeof MediaRecorder, opus: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') })
```

Expected `{ md: true, mr: "function", opus: true }`. (Before Step 1 the same expression returns `md: false` — that is the regression signature.) The simulator exposes WebKit's mock capture device, so recordings here are synthetic; stop at the capability check and do speech on the device.

### T3. Device (ElTelephono) against Luna — the three reports

Precondition: Luna has STT and TTS configured (`hermes tools`, Voice section) and the app is connected to it (Settings tab shows Luna highlighted, no `LocalModelBar`).

1. **Dictation.** Composer → voice menu → mic. First use: iOS system prompt with the Step 1 string → Allow. Speak a sentence, tap again. Expect: transcript inserted into the draft; no toast. Failure signatures: *"This runtime does not support microphone recording"* → Step 1 missing from the installed build; *"422: …"* in the transcription toast → Step 2 missing; a `TypeError: Load failed` toast → client-direct CORS (Section 7), set `voice.client_direct: false` on Luna and retry.
2. **Speak replies.** Voice menu → "Speak replies". Expect: no toast, item stays checked. Verify persistence: Settings → Voice shows "Read replies aloud" on, and `GET /api/config` on Luna returns `voice.auto_tts: true`. Send a prompt; expect the reply spoken (stream path) — if Luna has no streaming TTS provider the fallback `POST /api/audio/speak` path plays a data URL; both are exercised by Step 2.
3. **Ear.** Voice menu → "Hey Hermes" toggle. With Luna's wake engine installed and `capture` resolving to `client`: item turns on, long-press tooltip shows no notice, saying the phrase starts a fresh voice conversation. Without the engine: item stays off and the tooltip shows Luna's remediation text verbatim (e.g. *"Wake word needs speech-to-text and text-to-speech configured …"*). The regression signature this ADR fixes is the tooltip reading *"getUserMedia unavailable for client wake capture"*.
4. **Voice conversation.** Voice menu → "Start voice chat". Expect listening → transcribing → thinking (bubble blips) → speaking; talking over the reply cuts it (barge-in monitor — second capture stream) and submits the interruption.
5. **Settings autosave regression.** Settings → Appearance, flip any switch. Expect no "Autosave failed" (this was failing on every remote connection before Step 2).

### T4. Device — Issue 2

1. Launch on Luna, wait ≥ 10 s (embedded gateway reaches `ready`). Expect **no** `LocalModelBar`, upstream model pill visible, Settings tab highlights Luna.
2. Settings → tap "On-device" (reloads). Expect the bar after the boot overlay clears, "No model loaded" until a model is activated, model pill hidden.
3. Settings → tap Luna (reloads). Expect the bar gone and the pill back, with the embedded gateway still `Running` in the Settings row (it keeps running; it just is not selected — by design in ADR-002 D6).

### T5. Local mode voice (informational)

With "On-device" selected, dictation reaches the embedded gateway's `/api/audio/transcribe`, which needs an STT provider the embedded config does not ship (`python/ios_config.yaml` configures no `stt`, and the `tts` toolset is disabled). Expected outcome today: *"Transcription failed"* from the gateway, not a mobile failure. On-device STT/TTS (WebKit exposes `webkitSpeechRecognition` and `speechSynthesis` — measured in Section 2) is a candidate follow-up ADR, not part of this one.

## Consequences

- Voice on a remote gateway becomes a first-class mobile feature with zero upstream patches and zero native code — one plist key and a five-line transport fix.
- Every JSON write from the phone to a remote gateway starts working, not just the voice ones; this ADR should be understood as fixing "settings never saved on remote" as much as fixing the speaker icon.
- The on-device bar, the Settings highlight, and the model-pill CSS now all derive from the single routing flag the bridge uses, so they cannot disagree with where requests actually go.
- Deferred, with stated reasons: background capture/playback (native audio session work), on-device STT/TTS for local mode (separate ADR), multipart `upload` on native (not on any voice path — transcribe is a JSON data URL).

## Appendix — evidence and reproduction

Probe used for Section 2 (inject after `<body>` in a copy of the simulator `App.app`'s `public/index.html`, install with `xcrun simctl install`, run `xcrun simctl launch --console-pty <udid> com.mobilehermes.app` and grep the Capacitor `⚡️  [log]` lines):

```js
(function(){
  var types=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus','audio/ogg','audio/wav'];
  var info={secure:window.isSecureContext,origin:location.origin,mediaDevices:!!navigator.mediaDevices,
    gum:!!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia),MediaRecorder:typeof MediaRecorder,
    AudioContext:typeof AudioContext,SpeechRecognition:typeof webkitSpeechRecognition,speechSynthesis:typeof speechSynthesis};
  if(typeof MediaRecorder!=='undefined'){info.types={};types.forEach(function(t){info.types[t]=MediaRecorder.isTypeSupported(t)})}
  console.log('HERMES_PROBE1 '+JSON.stringify(info));
  if(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia){
    navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}}).then(function(s){
      console.log('HERMES_PROBE2 gum ok tracks='+s.getAudioTracks().length);
      var mt=types.filter(function(t){return MediaRecorder.isTypeSupported(t)})[0]||'';
      var r=new MediaRecorder(s, mt?{mimeType:mt}:undefined), chunks=[];
      r.ondataavailable=function(e){if(e.data.size>0)chunks.push(e.data)};
      r.onstop=function(){var b=new Blob(chunks,{type:r.mimeType||mt});
        console.log('HERMES_PROBE3 recorder stopped mime='+r.mimeType+' chunks='+chunks.length+' bytes='+b.size);
        s.getTracks().forEach(function(t){t.stop()})};
      r.start(); setTimeout(function(){r.stop()},1500);
    },function(e){console.log('HERMES_PROBE2 gum err '+e.name+' '+e.message)});
  }
})();
```

Run 1 — bundle as built 2026-09-08 (no `NSMicrophoneUsageDescription`):

```
HERMES_PROBE1 {"secure":true,"origin":"capacitor://localhost","mediaDevices":false,"gum":false,"MediaRecorder":"function","AudioContext":"function","SpeechRecognition":"function","speechSynthesis":"object","types":{"audio/webm;codecs=opus":true,"audio/webm":true,"audio/mp4":true,"audio/ogg;codecs=opus":false,"audio/ogg":false,"audio/wav":false}}
```

Run 2 — same bundle after `PlistBuddy -c "Add :NSMicrophoneUsageDescription string '…'"` and ad-hoc re-sign:

```
HERMES_PROBE1 {"secure":true,"origin":"capacitor://localhost","mediaDevices":true,"gum":true,"MediaRecorder":"function", … same types …}
HERMES_PROBE2 gum ok tracks=1 label=Mock audio device 1
HERMES_PROBE3 recorder started state=recording mime=audio/webm;codecs=opus
HERMES_PROBE3 recorder stopped mime=audio/webm; codecs=opus chunks=1 bytes=44015
```

Capacitor body-drop citation (verbatim, `node_modules/@capacitor/ios/Capacitor/Capacitor/Plugins/CapacitorUrlRequest.swift:215-221`, Capacitor 8.4.2):

```swift
public func setRequestBody(_ body: JSValue, _ dataType: String? = nil) throws {
    let contentType = self.getRequestHeader("Content-Type") as? String

    if contentType != nil {
        request.httpBody = try getRequestData(body, contentType!, dataType)
    }
}
```

and the call site `HttpRequestHandler.swift:207-215`, which passes only the caller-supplied `headers` before `setRequestBody(data, dataType)`.

The simulator was restored to the original DerivedData build and shut down after the probe; no project file was modified by the investigation.
