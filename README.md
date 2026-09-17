# Hermes Mobile

iOS client for [Hermes Agent](https://github.com/NousResearch/hermes-agent) — the full desktop experience on iPhone, with optional on-device inference.

## What it does

Runs the unmodified Hermes Agent desktop UI inside a native iOS app. The upstream codebase is a git submodule — zero lines patched. A bridge layer implements the ~130 `window.hermesDesktop` methods using iOS-native Capacitor plugins instead of Electron APIs.

**On-device inference**: An embedded Python gateway and MLX Swift inference engine let you run models (Qwen3, Hermes-3, Gemma) locally on the iPhone's Neural Engine. No cloud connection required — fully private, offline-capable inference.

## Architecture

```
┌─────────────────────────────────┐
│         Mobile Shell            │  ← Tab bar, settings, model bar
│  (replaces desktop chrome)      │
├─────────────────────────────────┤
│      ContribWiring (upstream)   │  ← Chat, auth, overlays — unchanged
├─────────────────────────────────┤
│    Bridge (window.hermesDesktop) │  ← ~130 methods, Capacitor native
├─────────────────────────────────┤
│  Local Gateway  │  MLX Engine   │  ← Embedded Python + on-device ML
└─────────────────────────────────┘
```

- **Upstream untouched** — git submodule at `upstream/`, never modified
- **Bridge** — `src/bridge/index.ts` implements every `hermesDesktop` method, enforced at compile time
- **Mobile shell** — `ContribWiring` (business logic) reused, `ContribController` (desktop chrome) replaced with iOS tab-bar layout
- **On-device inference** — CPython 3.13 embedded via BeeWare's iOS support, MLX Swift for model execution
- **Upgrade path** — bump submodule, run `npm run scan-bridge-usage`, implement any new methods. No merge conflicts.

## Status

| Phase | Status | What shipped |
|-------|--------|-------------|
| **Phase 0** | Complete | Bridge, Vite build, Capacitor shell |
| **Phase 1** | Complete | PKCE auth, mobile CSS, file attach, notifications, edge-swipe, request dedup |
| **Phase 2** | Complete | Haptics, deep links, battery signals, offline indicator, theme marketplace, share extension, iPad polish |
| **Phase L0** | Complete | Embedded Python gateway, cold-start <200ms |
| **Phase L1** | In progress | On-device MLX inference, model manager, local connection routing |
| **Phase M0** | Complete | Mobile shell, tab bar, settings, local model bar |

## Getting started

### Prerequisites

- macOS with Xcode 16+
- Node.js 20+
- An iPhone (or simulator for non-inference testing)
- Apple Developer account (free works, but apps expire every 7 days)

### Build

```bash
git clone --recursive https://github.com/ShawnCRMer/hermes-mobile.git
cd hermes-mobile
npm ci
cd upstream && npm ci && cd ..
npm run build
npx cap sync ios
```

**Important:** After `cap sync`, restore the Capacitor config (sync overwrites custom plugin entries):

```bash
cp ios/App/App/capacitor.config.json.bak ios/App/App/capacitor.config.json
```

### Run

Open `ios/App/App.xcodeproj` in Xcode, select your device or simulator, and hit Run. Or from the CLI:

```bash
xcodebuild -project ios/App/App.xcodeproj \
  -scheme App -sdk iphoneos -configuration Debug \
  -destination 'id=<YOUR_DEVICE_UDID>' \
  -skipPackagePluginValidation -allowProvisioningUpdates build
```

### On-device inference

1. Open the app → Settings → Model Manager
2. Download a model (Qwen3-1.7B is smallest for quick testing)
3. Tap "Load" to activate it
4. Chat — messages route through local MLX inference, no cloud needed

Requires a physical device (MLX needs Metal compute, simulators don't support it).

## Architecture decisions

- [ADR-001: Mobile architecture](docs/adr/ADR-001-mobile-architecture.md) — bridge pattern, zero upstream patches
- [ADR-002: Local gateway](docs/adr/ADR-002-local-gateway.md) — embedded Python + on-device inference
- [ADR-003: Voice/audio on iOS](docs/adr/ADR-003-voice-audio-mobile.md) — WKWebView capabilities, CapacitorHttp fixes

## Contributing

This project was built as a potential contribution to the Hermes Agent community. See [the upstream issue](https://github.com/NousResearch/hermes-agent/issues/113655) for discussion on adoption.

## License

Same license as [Hermes Agent](https://github.com/NousResearch/hermes-agent).
