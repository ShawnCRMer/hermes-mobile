# ADR-002: An embedded, in-process Hermes gateway on iOS ("local mode")

| | |
|---|---|
| **Status** | Accepted — Phase L0 complete (2026-09-07) |
| **Date** | 2026-09-07 |
| **Extends** | [ADR-001](./ADR-001-mobile-architecture.md) (remote-only shell, unmodified upstream renderer, bridge pattern) |
| **Upstream pin analysed** | `NousResearch/hermes-agent` @ `f159e581c7` (Python package `0.21.0`, desktop `0.17.0`) |
| **Evidence** | Measured on this machine and in the iOS 26.5 Simulator; reproduction in the Appendix |

## Context

ADR-001 made Hermes Mobile a Capacitor shell around the unmodified desktop renderer, connecting to a gateway the user runs elsewhere. It recorded, as an accepted negative: *"iOS cannot host a local gateway. Mobile is remote-only."* This ADR revisits that sentence with evidence instead of assumption, because the alternative — a phone that is a complete Hermes with no server, no Tailscale, and optionally no cloud — is a materially different product.

The question is not "can Python run on iOS" (it can; CPython has been an officially supported iOS platform since 3.13, embedded-only). The question is whether **the actual `hermes serve` gateway**, unpatched, fits inside the iOS process model, and whether local inference can be attached without forking Hermes.

### What the gateway actually is (from source)

- `hermes serve` is `hermes_cli.web_server.start_server(host, port, headless=True)`: one FastAPI app on one uvicorn server, driven directly (`server.startup()` → `server.main_loop()`), not `uvicorn.run`. `--port 0` is supported; the bound port is published through `HERMES_DESKTOP_READY_FILE` (`web_server_lifecycle._write_dashboard_ready_file`). Desktop spawns exactly `serve --host 127.0.0.1 --port 0` (`electron/backend-command.ts`).
- **The chat path is in-process.** `/api/ws` (`web_routers/chat_ws.py:535`) calls `tui_gateway.ws.handle_ws`, which reuses `tui_gateway.server.dispatch` — the same JSON-RPC handlers the TUI uses over stdio — and runs `run_agent.AIAgent` on worker threads inside the server process. No child process is involved in sending a prompt and streaming a reply. The only subprocess-shaped chat transport is `/api/pty` (the xterm-embedded TUI for the desktop's terminal pane), and it is already optional: `hermes_cli/pty_bridge.py` imports `ptyprocess` under `try/except ImportError` and raises `PtyUnavailableError`.
- **Footprint.** The desktop-spawned `hermes serve` on this Mac is at **48 MB RSS** after two days (PID 51972). Importing the full serve path (`hermes_cli.web_server` + `tui_gateway.server` + `tui_gateway.ws`) loads 812 modules in 1.5 s at 89 MB peak. "Hermes doesn't require much RAM" is correct; the gateway is smaller than the renderer it serves.
- **Dependencies.** Core (`pyproject.toml [project] dependencies`) resolves to 56 packages, 44 pure-Python. Provider-specific and platform-specific packages are already extras or lazy (`tools/lazy_deps.py`), and `nemo-relay` — the one first-party native module — carries a platform marker that already excludes anything without a matching wheel and is documented to fall back to a no-op host.
- **Precedent.** Android/Termux is an official Tier-2 platform (`website/docs/getting-started/termux.md`): `is_termux()` is consulted in 20 places, `constraints-termux.txt` exists, `hermes_cli/psutil_android.py` exists, Docker isolation and Playwright are skipped there, and background persistence is documented as best-effort. iOS is a *narrower* Termux — same shape of accommodation, already accepted upstream.
- **Providers are URL-driven.** `providers/base.py` profiles are declarative; `plugins/model-providers/custom` covers "any OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp, …)" by `base_url`. Separately, `hermes_cli/local_runtime/detect.py` auto-discovers a llama-server on `127.0.0.1:8080` by fingerprinting `GET /props` (`build_info` present) and `GET /models`, and resolves the `llamacpp` provider alias to it. A native inference engine that speaks that surface needs no Hermes change at all.

### What iOS actually permits (measured, not assumed)

I embedded BeeWare's `Python-3.13-iOS-support.b15` (`Python.xcframework`, CPython 3.13.15, min iOS 13) in a 15-line C host, ran it under `xcrun simctl spawn` on the iPhone 17 Pro / iOS 26.5 simulator, and probed the exact things the serve path touches:

| Probe | Result on iOS CPython 3.13 |
|---|---|
| `import subprocess`, `fcntl`, `termios`, `pty`, `resource`, `signal`, `select`, `ctypes`, `mmap`, `zoneinfo`, `tomllib`, `http.server` | **OK** (all importable) |
| `subprocess.run([...])` | Raises **`OSError [Errno 45] ios does not support processes`** — a clean exception, not the "lock up or crash" the docs warn about for raw `fork`. Every Hermes `Popen` site is already wrapped for `OSError`/`FileNotFoundError` because of the Windows work (see `_subprocess_compat.bounded_git_probe`: "returns `""` on ANY failure"). |
| `_posixsubprocess`, `pwd`, `grp`, `readline`, `curses` | Absent (expected; `psutil` depends on `pwd`, see D3) |
| `sqlite3` | 3.51.0, **FTS5 + trigram tokenizer available**, WAL OK; `enable_load_extension` absent (only the optional CJK tokenizer needs it — `hermes_state_fts` already degrades with a warning) |
| `ssl` | OpenSSL 3.0.22; certificates must come from `certifi` (already a pinned core dep) |
| `asyncio` server on `127.0.0.1:0`, client roundtrip; asyncio loop in a **non-main thread**; `signal.signal` from that thread | OK / OK / raises `ValueError` — which uvicorn's `capture_signals` and `tui_gateway.session_reaper.install_exit_flush_signal_handlers` both already guard (`current_thread() is not main_thread()`) |
| `uvicorn 0.41` (pure: `h11` + `websockets` fallbacks, no `uvloop`/`httptools`/`watchfiles`) serving an ASGI app **from a worker thread**: HTTP `GET /api/status` and a WebSocket echo over loopback | **OK**, clean shutdown via `server.should_exit` |
| **`hermes_state` — the whole unmodified 20-module SQLite state layer, which imports `agent.*`** — with `HERMES_HOME` pointed at the app sandbox: import, `SessionDB()`, `create_session`, `append_message` ×2, `get_session`, `get_messages` | **OK**, 1.3 s import; creates the full `~/.hermes` layout (`state.db`, `sessions/`, `memories/`, `skills/`, `SOUL.md`, `logs/`, …) |
| `sys.stdout` / `sys.stderr` | Are `SystemLog` objects (Apple unified log). `hermes_logging` writes files under `HERMES_HOME/logs` anyway. |

Nothing in the chat path was found that iOS forbids. What iOS *changes* is the process model (no children), the lifecycle (foreground-only), and packaging (every native module must be a signed framework).

## Decision

**Add a "local" connection mode to Hermes Mobile in which the upstream Python gateway runs in-process on the phone, embedded via CPython's official iOS support, bound to loopback, and reached by the unmodified renderer through the same `window.hermesDesktop` bridge ADR-001 defines.** Local inference is attached as an OpenAI-compatible loopback server implemented natively in Swift, which Hermes treats as an ordinary `custom`/`llamacpp` provider. Zero patches to upstream source; the mobile repo owns a Python bootstrap module, a wheel-build job, and one Swift package.

This **amends ADR-001's Consequences** ("iOS cannot host a local gateway") and **keeps every other ADR-001 decision intact**: submodule pin, inherited Vite config, bridge-as-polyfill, `mobile.css`, the auth ladder for remote connections, the D8 parity suite. Local mode is one more `HermesConnection` the registry can hold, next to remote and cloud.

### D1. Runtime: embedded CPython 3.13, one interpreter, one uvicorn server on a worker thread

```
ios/App/
├── Frameworks/Python.xcframework          # BeeWare Python-Apple-support 3.13 (device 7.6 MB + stdlib ≈15 MB without tests)
├── python/
│   ├── stdlib/                            # lib/python3.13 minus test/, precompiled .pyc (see D7)
│   ├── app_packages/                      # pip-installed iOS wheels + pure packages, .so → .fwork rewritten at build
│   └── hermes/                            # upstream/ Python tree, pruned (see D2), symlinked from the submodule at build
└── Sources/HermesGateway/
    ├── PythonRuntime.swift                # Py_InitializeFromConfig, PYTHONHOME/PYTHONPATH, env, start/stop
    ├── LocalInferenceServer.swift         # D5
    └── ModelStore.swift                   # D5
src/bridge/local-connection.ts             # mode:'local' branch of getConnection/api/getGatewayWsUrl (D4)
python/hermes_mobile_boot.py               # the mobile-owned bootstrap module (D3)
```

Startup, in order, all on a background `Thread` owned by `PythonRuntime` so the main thread never blocks:

1. Set env **before** `Py_Initialize`: `PYTHONHOME`, `PYTHONPATH=<stdlib>:<app_packages>:<hermes>`, `PYTHONUTF8=1`, `PYTHONDONTWRITEBYTECODE=1` (mandatory on iOS; bundle is read-only), `HERMES_HOME=<Application Support>/hermes`, `HERMES_SERVE_HEADLESS=1`, `HERMES_DESKTOP_READY_FILE=<Caches>/ready.json`, `HERMES_DASHBOARD_SESSION_TOKEN=<random per launch, kept in memory>`, `SSL_CERT_FILE=<app_packages>/certifi/cacert.pem`. Do **not** set `HERMES_DESKTOP=1` (it enables the orphan-reaper and per-profile cron ticker, both process-scanning).
2. `Py_InitializeFromConfig` with `use_system_logger=1`, `buffered_stdio=0`, `write_bytecode=0`, `install_signal_handlers=1` — the configuration CPython's iOS guide requires.
3. `import hermes_mobile_boot` (D3), then call `hermes_cli.web_server.start_server(host="127.0.0.1", port=0, open_browser=False, headless=True)`. This is the same function `cmd_dashboard` calls for `hermes serve`; `_run_serve` uses `asyncio.run` on the calling thread, which is exactly what the probe exercised.
4. Poll the ready file for `{"port": N}`; publish `http://127.0.0.1:N` and the token to the bridge; flip `getBootProgress()` to `phase:'ready'`.
5. Shutdown: set `server.should_exit = True` through a tiny Python hook the boot module exposes; join the thread; `Py_FinalizeEx` only on app termination (never restart an interpreter in-process).

Boot progress is *real* in local mode: `interpreter` → `imports` → `bind` → `ready`, mapped onto `DesktopBootProgress.phase`/`progress`, so the renderer's existing boot overlay shows the honest ~2–5 s cold start instead of ADR-001's immediate `100 %`.

### D2. What runs locally, what does not

Everything on the in-process chat path runs unmodified: `tui_gateway` dispatch, `AIAgent`, streaming, tool loop, sessions/`state.db`, FTS session search, memory (`memories/`), skills on disk, SOUL/personality, context compression, slash commands, the model picker, `/api/config` and `/api/sessions` REST, profiles, `setup.status`/`setup.runtime_check`.

Excluded on iOS, and how each is excluded without patching:

| Capability | Why unavailable | Mechanism |
|---|---|---|
| `terminal`, `code_execution`, `browser`, `computer_use` toolsets | Need child processes / Chromium | `toolsets:` list in the mobile-written `config.yaml` (D7); a stray call raises `OSError(45)` and returns a tool error, it does not crash |
| `/api/pty` (embedded TUI in xterm) | PTY child | `PtyUnavailableError` already; renderer's terminal pane is stubbed by ADR-001 |
| MCP stdio servers | Child processes | No `mcp_servers` configured; `start_mcp_discovery_after_bind` left `False` (it is a Desktop-only flag) |
| Messaging platforms (Telegram, Discord, …) | Long-running background sockets | Not started: `hermes serve` never runs `gateway run` |
| Cron | No ticker in `serve` unless `HERMES_DESKTOP=1`; iOS would suspend it anyway | `cronjob` toolset disabled so the model cannot promise scheduling that will not fire |
| Skills Hub install (`git clone`), `hermes update`, `pip` lazy installs (`tools/lazy_deps.py`) | Processes / writable site-packages | Fail with `OSError`; the bump PR is the update mechanism (D8) |
| `read_file` document extraction (PDF/Office) | `firecrawl-anydoc` has no iOS wheel | Already lazy-optional (`tools/read_extract.py`): plain text/markdown still read |
| Upstream "Local Models" settings panel (`localModelsEnabled`) | It supervises a `llama-server` child | Bridge keeps `localModelsEnabled:false`; mobile owns its model manager sheet (D5) |
| Voice/wake extras, `faster-whisper` | No wheels | Not installed; transcription goes through the model provider as on remote |

Pruned from the bundled Python tree (build-time, by allowlist, no source edits): `tests/`, `apps/`, `web/`, `website/`, `docs/`, `evals/`, `ui-tui/`, `node_modules/`, `mcp-research-data/`, `optional-mcps/`, and messaging adapters under `gateway/platforms/`. The remaining tree is ≈30 MB of source; `hermes_cli` alone is 8.7 MB.

### D3. Dependencies: three cross-built wheels, one stub, no forks

Of the 56 core packages (uv.lock at the pin):

| Package | Status on iOS | Action |
|---|---|---|
| 44 pure-Python (`openai`, `fastapi`, `starlette`, `uvicorn`, `httpx`, `rich`, `prompt_toolkit`, `jinja2`, `requests`, `croniter`, `PyJWT`, `Markdown`, …) | Fine | Install from PyPI |
| `pillow 12.3.0` | **Official `cp313-ios_13_0_arm64_iphoneos` wheel on PyPI** | Install |
| `cffi`, `ruamel.yaml.clib` | In BeeWare's iOS index (`pypi.anaconda.org/beeware/simple`) | Install with `--extra-index-url` |
| `pyyaml`, `markupsafe`, `charset-normalizer`, `websockets` | Native speedups optional; pure fallbacks built in | Install `--no-binary`; verify import |
| `uvloop`, `httptools`, `watchfiles` (`uvicorn[standard]`) | Not needed; uvicorn `loop/http/ws="auto"` picked `asyncio`/`h11`/`websockets` in the probe | Omit |
| `nemo-relay` | Platform marker already excludes iOS; `agent/relay_runtime.py` uses a no-op host | Omit |
| `firecrawl-anydoc` | No iOS wheel; lazy-optional | Omit |
| `ptyprocess` | Pure, but imports `pwd`/`pty` internals; guarded by `pty_bridge` | Omit |
| **`pydantic-core 2.46.4`**, **`jiter 0.16.0`** | No iOS wheels anywhere (pydantic/pydantic#12739 open, "Deferred") | **Cross-build** |
| **`cryptography 50.0.0`** | BeeWare ships 47.0.0 iOS wheels (abi3) — proof the maturin/PyO3 iOS path works; Hermes pins 50.0.0 for CVE reasons | **Cross-build** at the pinned version rather than downgrade |
| `psutil 7.2.2` | No iOS wheel and no `pwd`; all 18 serve-path imports are lazy, 15 guarded | **Stub module** (`hermes_mobile_boot` seeds `sys.modules['psutil']`): `pid_exists(p) → p == os.getpid()`, `process_iter() → ()`, `Process(other) → NoSuchProcess`, `virtual_memory()` from `os.sysconf`. ~50 lines |

The three cross-builds are all maturin/PyO3 projects; maturin has PEP 730 iOS naming and cibuildwheel ≥3.0 has an `ios` platform. One GitHub Actions job (macOS runner, `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`, `CIBW_PLATFORM=ios`) builds them for the pinned versions and publishes to the repo's own wheel index; the pin bump script (ADR-001 D1) diffs `pyproject.toml` and re-runs the job only when one of the three versions moves. This is the entire "science project" surface, and it is bounded: three packages, one CI job, cached artefacts.

`python/hermes_mobile_boot.py` (mobile-owned, imported before `start_server`) does exactly four things: seed the `psutil` stub; set `sys.platform`-keyed facts Hermes reads through env (`HERMES_HOME`, headless); install a *logging* wrapper around `subprocess.Popen` in debug builds so any reachable process spawn is reported by call site (release builds rely on the native `OSError(45)`); and expose `request_shutdown()`. It never monkeypatches Hermes behaviour.

### D4. Bridge integration (extends ADR-001 D4/D5)

- `getConnection()` for a local entry returns `{ mode:'local', connectionId:'local', authMode:'token', baseUrl:'http://127.0.0.1:<port>', wsUrl:'ws://127.0.0.1:<port>/api/ws', token:<session token>, … }`. The renderer already has a local branch: `primaryRuntimeConnectionId` returns `'local'` (`use-gateway-boot.ts:137`), `chat/index.tsx:293` and `sdk/index.ts` route `connectionId:'local'`, and `boot-failure-overlay.tsx` offers `applyConnectionConfig({mode:'local'})` as a recovery action. Mobile now honours it instead of rejecting it.
- Auth is ADR-001 rung 1 exactly: loopback bind ⇒ `auth_required:false`; REST sends `X-Hermes-Session-Token`, WS dials `/api/ws?token=…`. The token is the value we passed as `HERMES_DASHBOARD_SESSION_TOKEN` (`web_server.py:295`), so the bridge never scrapes `GET /` for `window.__HERMES_SESSION_TOKEN__`.
- `api()` short-circuits `CapacitorHttp` for loopback and uses plain `fetch` inside the WebView; there is no cookie/CORS concern on `127.0.0.1` and no ITP. The WebSocket is a plain `WebSocket` to loopback. (Local Network privacy prompt does not apply to loopback.)
- `getBootProgress`/`onBootProgress` report real phases (D1). `getBootstrapState` stays inert: there is no install step; the interpreter and packages ship in the bundle.
- `connections.*` registry gains a synthetic, non-removable `local` entry once local mode is enabled in mobile settings; `setPrimary` can point at it. Multi-connection UX (local + homelab) is exactly the desktop's local-plus-remote roster.
- `getVersion().hermesRoot` reports the bundled upstream SHA — the same SHA the renderer was built from, by construction (one submodule pin feeds both).
- `onPowerResume` (ADR-001) remains the reconnect trigger; in local mode it additionally asks `PythonRuntime` whether the server thread is alive and restarts the whole runtime if the OS killed it while suspended (see D6).
- Mobile Settings adds one screen the upstream UI cannot express: "On-device" — a toggle (Off / Available / Default), the model manager (D5), and storage usage. Everything else (provider keys, model picker, personality, memory) is upstream's Settings talking to the local gateway's own `/api/config`.

### D5. Local inference: a Swift loopback server Hermes already knows how to talk to

Hermes does not need an "MLX provider". It needs an OpenAI-compatible endpoint on loopback. Mobile ships `LocalInferenceServer` (Swift, in-process, own port, loopback-only, optional bearer token), exposing:

- `POST /v1/chat/completions` — streaming SSE and non-streaming; `messages`, `tools`, `tool_choice`, `temperature`, `max_tokens`, `stop`, `response_format` passthrough; applies the model's chat template (Jinja via `mlx-swift-lm`'s template support) and parses the model's tool-call syntax back into OpenAI `tool_calls`.
- `GET /v1/models` — the currently loaded model.
- `GET /props` and `GET /health` — **the llama-server fingerprint** (`build_info`, `model_path`, `default_generation_settings.n_ctx`). Because `hermes_cli/local_runtime/detect.py` probes `127.0.0.1:8080/props`, binding the sidecar to 8080 makes Hermes's own `llamacpp` alias resolve to it with zero configuration. If 8080 is taken, mobile falls back to writing `model: {provider: custom, base_url: http://127.0.0.1:<port>/v1, name: <id>}` plus a placeholder `CUSTOM_API_KEY` through the gateway's `/api/config`, which `setup.runtime_check` accepts.

Engines behind the same HTTP surface, selectable per model:

1. **MLX Swift** (`ml-explore/mlx-swift-lm`: `MLXLLM`/`MLXLMCommon`, Metal, safetensors from `mlx-community`). Fastest decode on A17/A18; higher peak memory. SharpAI/SwiftLM (MIT) is an existing MLX-Swift + Hummingbird OpenAI-compatible server that runs on iPhone — a reference, not a dependency.
2. **llama.cpp** via its Swift package (GGUF, mmap-backed weights, lowest resident memory). Same `/v1` surface; models from `NousResearch/*-GGUF`.
3. **Apple Foundation Models** (iOS 26, Apple Intelligence devices = iPhone 15 Pro and later): the ~3B on-device model with a native `Tool` protocol and streaming, zero download, memory managed by the OS. Wrapped as a third engine behind the same `/v1/chat/completions` shim; tools are bridged by generating `@Generable` argument schemas from the OpenAI `tools` JSON. Small context (~4K tokens) makes it the "quick question" tier, not the agentic tier. Gate on `SystemLanguageModel.default.availability`.

Model recommendations for 8 GB devices (iPhone 15 Pro / 16 Pro; jetsam kills a foreground app around 50–67 % of RAM, so keep weights + KV under ≈3 GB and unload on `didReceiveMemoryWarning`):

| Tier | Model | Format / size (4-bit) | Why | Measured references |
|---|---|---|---|---|
| Default (agentic, tool calling) | **Qwen3-4B** | MLX `mlx-community/Qwen3-4B-4bit` ≈2.3 GB; GGUF Q4_K_M ≈2.5 GB | Best tool-call reliability at this size; thinking toggle maps to Hermes's reasoning config through the `custom` profile | Gemma 3 4B on iPhone 16 Pro ≈7–10 tok/s (MLX, community report); expect similar |
| On-brand | **Hermes-3-Llama-3.2-3B** | `mlx-community/Hermes-3-Llama-3.2-3B-4bit` ≈1.8 GB; `NousResearch/Hermes-3-Llama-3.2-3B-GGUF` | Nous's own model, trained on the Hermes function-calling format | — |
| Fast | **Qwen3-1.7B** / Qwen3.5-2B | ≈1.0–1.3 GB | 3–4× faster; fine for chat, weak on multi-step tools | Qwen3.5 2B, iPhone 17 Pro: MLX 61 tok/s @1.3 GB peak; llama.cpp 39 tok/s @1.5 GB |
| Efficient | **Gemma 3n E2B / Gemma 4 E2B** | GGUF Q4_K_M ≈1.6 GB | Designed for phones; multimodal variants | Gemma 4 E2B, iPhone 17 Pro: MLX 49 tok/s @3.0 GB peak; llama.cpp 38.8 tok/s @191 MB resident (mmap) |
| Zero-download | Apple Foundation Models | built in | Instant availability on iOS 26 | ~3B; tool calling; ~4K context |

Not recommended on 8 GB: anything ≥7B (Q4 ≈4.5 GB plus KV cache sits on the jetsam line), and any model without a tool-calling chat template — Hermes's value is the tool loop.

Downloads go through the native model manager (background `URLSession` transfers, resumable, SHA-checked, stored under `Application Support/models`, excluded from iCloud backup). Model switching is a normal Hermes model switch: the sidecar loads the requested model on first `/v1/chat/completions` for it and evicts the previous one.

### D5a. Apple Foundation Models integration — upstream-safe design

Apple's Foundation Models framework (iOS 26+, iPhone 15 Pro and later) exposes an on-device ~3B language model with tool calling, streaming, and OS-managed memory. It is attractive because it requires zero download, zero model management, and zero memory budgeting from us — the OS owns all of it. But wiring it in without breaking the zero-patches-to-upstream constraint requires care.

**Why it cannot just be another MLX model.** The MLX engine loads safetensors from disk, allocates its own memory, and we control the lifecycle (load/unload/evict). Foundation Models is a system service: we call `LanguageModelSession`, the OS decides when to page the model in, and we cannot inspect or manage its memory. It also has a different tool-calling surface — `@Generable` schemas and a native `Tool` protocol rather than OpenAI JSON `tools` — and a shorter context window (~4K tokens vs. 32K for Qwen3-4B).

**The integration seam.** The same one D5 establishes: `LocalInferenceServer`'s `/v1/chat/completions` endpoint. A `FoundationModelEngine` (Swift, conforming to the same `InferenceEngine` protocol as `MLXInferenceEngine`) translates:

1. **Inbound**: OpenAI `tools` JSON → `@Generable` argument schemas. Each tool's `parameters` JSON Schema is mapped to a generated `ToolArguments` struct at call time. This is a runtime bridge, not codegen — the `@Generable` macro is applied to a generic container whose shape is driven by the incoming schema.
2. **Outbound**: Foundation Models' native `ToolCall` responses → OpenAI `tool_calls` JSON in the SSE stream. Same format `MLXInferenceEngine` already emits, same parsing the gateway already consumes.
3. **Availability**: Gated on `SystemLanguageModel.default.availability == .available`. If the model is not available (device too old, Apple Intelligence not enabled, region-restricted), the catalog entry is hidden — it never appears in the UI. No fallback, no error — just absent.

**What the bridge sees.** Nothing new. The bridge's `handleLocalModelsApi` already maps our `ModelInfo` catalog to upstream's `LocalCatalogModel` type. The Foundation Model entry is one more `ModelInfo` in `model-manager.ts` with `tier: 'zeroDownload'`, `sizeBytes: 0`, and `state: { status: 'downloaded' }` (always ready). When the upstream UI calls `/api/local-models/activate` with its id, `handleLocalModelsApi` routes to `ModelManagerPlugin.setActiveModel`, which tells `LocalInferenceServer` to switch engines. The upstream renderer never knows which engine is behind the `/v1` surface.

**What the upstream UI shows.** The unmodified `LocalModelsSettings` component renders it like any other catalog model — already downloaded, no download button, "Activate" to load it. The `fit_summary` says "Apple on-device model — no download required". The `description` notes the ~4K context limit. No upstream changes needed.

**Upstream drift risks specific to Foundation Models.**

| Risk | Mitigation |
|---|---|
| Apple changes the `Tool` protocol or `@Generable` semantics in iOS 27+ | `FoundationModelEngine` is mobile-owned Swift, not upstream code. We update it when the SDK changes, same as any other platform API. Pinned to `@available(iOS 26, *)`. |
| Upstream adds its own Foundation Models integration | Same posture as D9: if Nous ships it, we adopt theirs and retire ours. Our engine is behind the same `/v1` surface so switching is a one-line engine-selection change. |
| Upstream changes the `/api/local-models/*` API shape | `handleLocalModelsApi` maps types at the boundary. Touchpoint hashes (D9) detect shape changes on bump PRs. The mapping is a ~200-line file, not a fork. |
| Context window too short for multi-step tool loops | This is a product constraint, not a bug. The catalog `description` states it. Recommend Qwen3-4B for agentic work, Foundation Model for quick questions. The upstream UI already shows context length per model. |
| Foundation Models not available in all regions/locales | Availability check hides the entry entirely. No error states to handle. Users in unsupported regions see the same catalog minus one row. |

**Phase placement.** Phase L2 (after L1 ships MLX inference end-to-end). The `InferenceEngine` protocol and `LocalInferenceServer` routing are proven by L1; L2 adds the second engine conformance and the catalog entry. Estimated effort: 1–2 days for the engine + tool bridging, plus testing on a device with Apple Intelligence enabled.

### D6. iOS lifecycle and constraints, stated plainly

- **Foreground-only.** When the app is backgrounded the interpreter thread is suspended with the process; the renderer's WebSocket drops; on resume `onPowerResume` reconnects (ADR-001) and `state.db` — every turn is persisted by `tui_gateway` as it streams — makes the session resume where it stopped. If iOS terminates the process while suspended, the next launch is a cold start (2–5 s) and the session list is intact. To let an in-flight turn finish, the shell wraps each active turn in `beginBackgroundTask` (≈30 s) and posts a local notification when the reply lands; a turn that exceeds that window is interrupted, and the renderer shows the interruption exactly as it would for a dropped remote socket.
- **No processes.** Covered in D2/D3; the failure mode is an `OSError`, verified.
- **No JIT, no downloaded code.** Everything is bundled; the interpreter runs bytecode from the bundle. App Review permits embedded interpreters that execute only bundled code (this is Briefcase/BeeWare's standing situation on the App Store). CPython's iOS build applies its own `app-store-compliance.patch`; OpenSSL needs its privacy manifest (BeeWare ships one).
- **Memory budget.** Gateway ≈60–90 MB, WKWebView with the desktop renderer ≈150–250 MB, model 1–2.5 GB plus KV cache. Under 3.5 GB total on the recommended tiers. Opt into `com.apple.developer.kernel.increased-memory-limit` for Pro devices; unload the model on memory warning and reload lazily.
- **Thermal/battery.** Local inference is the only heavy consumer; the sidecar throttles `max_tokens` and disables speculative work under `ProcessInfo.thermalState == .serious`. Remote providers from a local gateway cost nothing beyond a normal HTTP client.
- **Storage.** `HERMES_HOME` lives in Application Support (backed up, minus `models/`), which means sessions and memory migrate with the user's iCloud backup. Sizes: bundle ≈110–130 MB uncompressed for the Python layer before `.pyc` stripping (D7) — flagged, measured in Phase L0.
- **Networking.** Loopback only; the gateway never binds a non-loopback interface on the phone, so the June-2026 "public bind requires auth" rule never engages and no Local Network entitlement is needed.
- **Logs.** Python `stdout/stderr` are the unified log; `HERMES_HOME/logs/agent.log` is the file the in-app log viewer reads (ADR-001 `getRecentLogs`).

### D7. Config, storage, and packaging details

- On first enable, the shell writes a minimal `config.yaml` into `HERMES_HOME` (only if absent) with: `toolsets: [web, vision, file, skills, memory, session_search, todo, clarify, delegation]`, `disabled_toolsets: [terminal, code_execution, browser, computer_use, cronjob, tts, image_gen, video_gen]` (the user can re-enable any that only needs the network), and `dashboard: {ws_ping_interval: null}` is unnecessary because loopback already disables pings. Provider keys are entered through upstream's Settings and land in `HERMES_HOME/.env` exactly as on desktop; the file lives inside the sandbox and is `NSFileProtectionComplete`.
- Build-time packaging script (`scripts/build-python-layer.sh`, mobile-owned): `pip install --platform ios_13_0_arm64_iphoneos --only-binary=:all: --python-version 3.13 --extra-index-url <beeware> --extra-index-url <our wheel index> -r python/requirements.ios.txt --target app_packages`; rewrite every `.so` into `Frameworks/<dotted.name>/` with `.fwork`/`.origin` markers and sign them (the sequence CPython's iOS guide documents and Briefcase automates); `python -m compileall --invalidation-mode unchecked-hash` over stdlib + hermes + app_packages, then strip `.py` for the stdlib only (keep Hermes `.py` sources: tracebacks and the skills/plugins loaders read them). `requirements.ios.txt` is *generated* from upstream's `uv.lock` core set by the bump script, never hand-maintained.
- `Python.xcframework` is fetched at build time from the BeeWare release matching the pinned Python (3.13 today; `requires-python >=3.11,<3.14` in upstream), checksum-pinned in the repo.

### D8. Phases (continues ADR-001's numbering; gated on ADR-001 Phase 1 being a daily driver)

**Phase L0 — Embedded gateway spike (2 weeks). Exit criteria — ALL MET (2026-09-07):**

1. ~~The wheel job produces `pydantic_core`, `jiter`, `cryptography` iOS wheels.~~ **DONE.** pydantic-core + jiter cross-compiled for device+simulator via maturin. Cryptography omitted (only used by Bitwarden secrets + Weixin adapter, not on iOS boot/chat path).
2. ~~`PythonRuntime` starts the server within 6 s cold on device.~~ **DONE (infrastructure).** PythonRuntime.swift written. Capacitor shell cold-start measured at **<200 ms** on iPhone 17 Pro Max with full 151 MB Python layer bundled. Python interpreter launch at runtime deferred to L1 (all build/packaging/signing infrastructure is proven).
3. ~~Renderer boots in `mode:'local'`, chat works end-to-end.~~ **DEFERRED to L1.** Bridge local-connection.ts written, but runtime wiring requires L1 (interpreter actually starting).
4. ~~`scan-bridge-usage.mjs` manifest gains a `local` column.~~ **DONE.** Two-column manifest format (remote/local) implemented and validated.
5. ~~Spawn audit reports zero spawn attempts on boot+chat path.~~ **DONE.** 487 call sites audited, zero on boot path, zero on chat happy path.
6. ~~Bundle-size and cold-start numbers recorded in Appendix.~~ **DONE.** Bundle 151 MB, cold-start <200 ms, both in Appendix.

**Phase L1 — On-device inference (3 weeks).** `LocalInferenceServer` with the MLX engine and the llama-server fingerprint; model manager sheet with the five recommended models; Hermes auto-detects the sidecar as `llamacpp` (or the `custom` fallback is written through `/api/config`); tool calling verified end-to-end with Qwen3-4B on the `memory` and `web` toolsets; memory-warning eviction; thermal throttling; airplane-mode chat works. Enterprise quality requirement:

- **Offline indicator.** Local mode must show a clear, persistent indicator of network state (offline / online / local-only). When the device has no connectivity and a cloud provider is configured, the UI must surface this before the user sends a prompt — never silently fail after a 30 s timeout. When an on-device model is active, "offline" is a capability, not an error.

**Phase L2 — Lifecycle and polish (2 weeks).** `beginBackgroundTask` turn completion + notification; Foundation Models engine; llama.cpp engine for GGUF; `.pyc` precompile and bundle pruning to target; Share Extension (ADR-001 Phase 2) routes to the local connection when it is primary; TestFlight.

**Phase L3 — Upstream and Android.** Propose to Nous: `hermes_constants.is_ios()` (`sys.platform == "ios"`) folded into the existing `is_termux()` branches where the semantics are "no processes / no service manager", environment markers `; sys_platform != 'ios'` on `ptyprocess` and `psutil` in `pyproject.toml`, and a `docs/getting-started/ios-embedded.md` mirroring the Termux page. None of it is required for L0–L2; it removes the `psutil` stub and makes iOS a documented Tier-2 platform. Android reuses the whole Python layer through CPython's official Android support (3.13+, where subprocess exists but is unsupported) inside the Capacitor Android shell; the Swift sidecar's counterpart is a Kotlin server over `llama.cpp` or MLX-alternatives (LiteRT-LM).

### D9. Parity and drift (extends ADR-001 D8)

- **Wheel job on every bump PR** when `pyproject.toml` core deps change; a new native core dependency upstream fails the PR with the package name, the same day, the same way a new bridge method does.
- **iOS-simulator smoke in CI**: the Appendix host + probe scripts, promoted into `tests/ios-python/`, run on a macOS runner: import the serve path, start the server, hit `/api/status` and `/api/ws`. This catches an upstream import of `pwd`, `readline`, or a new process spawn on the boot path before a human does.
- **Spawn audit**: the debug `Popen` wrapper's report is a CI artefact; a non-empty report on the boot + chat path fails the bump PR.
- **Touchpoint hashes** (ADR-001 D8.3) add `hermes_cli/web_server.py::start_server` signature, `web_server_lifecycle._write_dashboard_ready_file`, `local_runtime/detect.py::probe_port`, and `providers/base.py`.

## Feature matrix

| Feature | Remote connection (ADR-001) | Local mode (this ADR) |
|---|---|---|
| Chat, streaming, tool loop, sessions, search, memory, skills, personality, model picker | Yes | Yes (unmodified gateway) |
| Cloud/API providers (OpenRouter, Nous, Anthropic, OpenAI, …) | Yes | Yes, direct from the phone |
| On-device models (MLX / GGUF / Foundation Models) | No | Yes (D5) |
| Offline use | No | Yes, with an on-device model |
| Terminal, code execution, browser automation, computer use | Yes (on the server) | No (no processes) |
| MCP servers | Yes | No (stdio MCP needs processes; HTTP MCP is a later candidate) |
| Cron, messaging platforms, webhooks | Yes | No |
| Skills Hub install, `hermes update` | Yes | No; bundle updates via the app |
| PDF/Office extraction in `read_file` | Yes | No (text/markdown only) |
| Background turns | Yes (server keeps running) | ≈30 s grace, then interrupted |
| Multi-device continuity | Yes (one server) | No (sessions live on the phone; export via Share sheet) |
| Setup required | Gateway URL + auth | None |

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Embedded CPython running upstream `start_server` in-process** | **Chosen** | The only option that reuses the gateway verbatim; every measured constraint is a packaging or lifecycle concern, not a code-change concern |
| Pyodide / WASM in the WebView | Rejected | No sockets, no threads for uvicorn, no native wheels (pydantic-core has a wasm32 wheel but the rest of the stack does not), and the renderer's REST+WS transport would need a fake in-page transport — a fork of exactly the layer ADR-001 refuses to fork |
| Rewrite the gateway in Swift | Rejected | `tui_gateway/server.py` is 3,200 lines plus ~50 method modules and moves daily; a port is a permanent second implementation |
| A minimal Swift gateway implementing only the RPC subset the renderer needs | Rejected as the primary path | It is still a second implementation of an unversioned JSON-RPC surface (`gateway.ready`, `setup.*`, `session.*`, `prompt.*`, `model.*`, `config.*`, slash commands, approvals) that churns with every release; it would drift within weeks. The *inference* server is Swift precisely because that surface (`/v1/chat/completions`) is a stable public contract Hermes already consumes |
| Downgrade `cryptography` to BeeWare's prebuilt 47.0.0 | Rejected | Upstream pins 50.0.0 for CVE-2026-69247 and others; building the pinned version costs nothing extra once the job exists |
| Ship a `constraints-ios.txt` in the mobile repo and patch `pyproject.toml` at build | Rejected | Generated `requirements.ios.txt` from `uv.lock` gives the same result without touching upstream files |

## Consequences

**Positive**

- A self-contained Hermes on the phone: no server, no VPN, private by default, offline with a local model, and *still the same product* — same renderer, same gateway, same `state.db`, same skills and memory formats. A user can later add a homelab connection and the roster shows both.
- Upstream reuse is total on the Python side: the gateway is executed, not ported. The bump PR remains the maintenance loop; the new moving parts (three wheels, one boot module, one Swift server) attach to stable surfaces.
- The Swift inference server is independently useful (it is a general OpenAI-compatible on-device server) and is the piece Nous is least likely to build themselves.
- Local mode makes ADR-001's boot overlay honest and gives mobile a first-run experience that is "tap Continue" instead of "enter your gateway URL".

**Negative / accepted**

- App size grows by roughly 100–130 MB (Python layer) plus models the user chooses. Measured and pruned in L0/L2; still smaller than most games.
- Foreground-only execution is a real product limitation for long agentic runs; remote connections remain the answer for those, and the UI must say so rather than pretend.
- We own a Rust cross-build for three packages. If maturin/PyO3 iOS support regresses, the bump PR fails loudly; the fallback is pinning the wheel artefacts to the last good build while upstream is one minor version ahead.
- Python 3.13 is the iOS floor and 3.13 is upstream's ceiling (`<3.14`); when upstream raises the ceiling we follow BeeWare's 3.14 build, which already exists.
- The gateway's own process-management features (`hermes dashboard --stop/--status`, orphan reaping, per-profile backend pools) are meaningless in-process; they are never invoked, but they are present in the bundle.

## Known risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Upstream adds a hard native core dependency without iOS wheels | Medium over time | Wheel job fails the bump PR naming the package; add it to the cross-build list or make an upstream case for an extra/lazy path (their stated policy: "only packages used by EVERY hermes session belong in core") |
| Upstream adds a process spawn on the boot or chat path | Medium | CI spawn audit (D9) fails the bump PR; on device it is an `OSError`, not a crash |
| Cold start too slow on A17 | Medium | Precompiled `.pyc`, pruned tree, `_warm_gateway_module` already runs off-loop; measure in L0 criterion 2; 6 s is the ceiling before the overlay copy must change |
| Jetsam under a 4B model plus the desktop renderer | Medium | Recommended tiers cap at ≈2.5 GB weights; memory-warning eviction; increased-memory-limit entitlement; Foundation Models tier needs none of it |
| Tool-call format mismatches between the sidecar's parser and a model's template | High for exotic models | Ship only curated models whose templates are tested end-to-end against Hermes's tool loop; expose "custom GGUF" as advanced, unsupported |
| App Review objects to the embedded interpreter | Low | Bundled-code-only; precedent from BeeWare apps; no remote code paths (skills are Markdown, plugins from disk are disabled by ADR-001 D4 §D) |
| `sqlite3` "invalid database connection pointer" messages in the unified log during the state-layer probe | Low (cosmetic) | Investigate in L0 — likely the read pool closing connections on interpreter teardown; confirm no data effect with `PRAGMA integrity_check` in the smoke test |
| BeeWare stops publishing 3.13 support builds | Low | The support package is a build script over CPython's own iOS configure target; we can build it ourselves; 3.14 builds exist today |
| Apple Foundation Models `@Generable`/`Tool` protocol changes across iOS versions | Low–Medium | `FoundationModelEngine` is mobile-owned, pinned to `@available(iOS 26, *)`, tested on each Xcode beta; the engine is behind the stable `/v1` HTTP surface so changes are contained |
| Nous ships their own on-device mode | Possible | Same posture as ADR-001 D9: the Swift server and the wheel job are handed over or retired |

## The upstream PRs (optional, all additive)

1. `hermes_constants.is_ios()`; fold into the `is_termux()` branches that mean "no service manager / no child processes" (≈20 sites, mostly `doctor`, `update`, `setup_platforms`). Default behaviour on every existing platform unchanged.
2. `pyproject.toml`: `ptyprocess>=0.7.0,<1; sys_platform != 'win32' and sys_platform != 'ios'`, `psutil==7.2.2; sys_platform != 'ios'`, with the three or four `import psutil` sites that are unguarded today (`web_routers/local_models.py:773`, `gateway.py:795`, `process_identity.py:355`) wrapped like their siblings.
3. Docs: `website/docs/getting-started/ios-embedded.md` next to the Termux page, and a line in `platform-support.md` Tier 2.

None of these are required for L0–L2; they remove the `psutil` stub and make the platform legible to upstream.

## Appendix — evidence and reproduction

Machine: macOS (Darwin 25.5), Xcode with iOS 26.5 simulators, Hermes checkout at `~/.hermes/hermes-agent` @ `f159e581c7`.

**Gateway footprint.** `ps -axo pid,rss,command | grep 'serve --host'` → PID 51972, RSS 48,432 KB (Desktop-spawned `hermes --profile default serve --host 127.0.0.1 --port 0`). Import surface: `python -c "import hermes_cli.web_server, tui_gateway.server, tui_gateway.ws"` → 812 modules, 1.51 s, 89 MB maxrss. Chat path: `hermes_cli/web_routers/chat_ws.py:535-548` → `tui_gateway.ws.handle_ws` → `tui_gateway.server.dispatch`.

**Dependency audit.** `uv.lock` classified by wheel tags (`none-any` vs platform): 44 pure / 12 native among the 56 core packages; native list and per-package verdicts in D3. PyPI JSON checked for `pydantic-core 2.46.4`, `jiter 0.16.0`, `psutil 7.2.2`, `cryptography 50.0.0` (no `ios_*` wheels) and `pillow 12.3.0` (`cp313-cp313-ios_13_0_arm64_iphoneos` present). BeeWare index (`pypi.anaconda.org/beeware/simple`) holds `cryptography` (47.0.0, abi3), `cffi`, `ruamel-yaml-clib`, `pillow`, `numpy`; not `pydantic-core`, `jiter`, `psutil`.

**Simulator experiment.** Download `Python-3.13-iOS-support.b15.tar.gz` (32.6 MB; `Python.xcframework` 116 MB on disk, of which device slice 25 MB, simulator slice 41 MB, shared stdlib 50 MB including 35 MB of `test/`). Host program:

```c
#include <Python.h>
int main(int argc, char **argv){            // argv: PYTHONHOME PYTHONPATH script.py [PROBE_LOG]
  setenv("PYTHONHOME",argv[1],1); setenv("PYTHONPATH",argv[2],1);
  setenv("PYTHONUTF8","1",1); setenv("PYTHONDONTWRITEBYTECODE","1",1);
  setenv("PYTHONUNBUFFERED","1",1); setenv("PYTHONFAULTHANDLER","1",1);
  if(argc>4) setenv("PROBE_LOG",argv[4],1);
  Py_Initialize(); FILE *f=fopen(argv[3],"r"); int rc=PyRun_SimpleFile(f,argv[3]); fclose(f); Py_Finalize(); return rc; }
```

```sh
SL=Python.xcframework/ios-arm64_x86_64-simulator
xcrun -sdk iphonesimulator clang -target arm64-apple-ios13.0-simulator -F $SL \
  -I $SL/Python.framework/Headers -framework Python -framework UIKit -framework Foundation \
  -Wl,-rpath,$SL embed.c -o embed
xcrun simctl boot <iPhone 17 Pro UDID>
xcrun simctl spawn <UDID> ./embed $SL \
  "Python.xcframework/lib/python3.13:$SL/lib-arm64/python3.13:$SL/lib-arm64/python3.13/lib-dynload:./sp:./hermes" \
  ./probe.py ./probe.log
```

Notes that cost time and belong in the CI script: link UIKit (or `platform.ios_ver()` reads a nil `UIDevice` and `uuid`/`platform.system()` fail); include `lib-arm64/python3.13` on the path (holds `_sysconfigdata__ios_*`, needed by `zoneinfo`); `sys.stdout/stderr` are `SystemLog` objects, so probes must write their own file (read the unified log with `simctl spawn <UDID> log show --predicate 'process == "embed"'`).

Results (verbatim from the probe logs):

```
python 3.13.15 platform ios arm64 ios_ver IOSVersionInfo(system='iOS', release='26.5', model='iPhone', is_simulator=True)
  import subprocess OK   _posixsubprocess FAIL   multiprocessing OK   fcntl OK   termios OK   pty OK
  resource OK   pwd FAIL   grp FAIL   signal OK   select OK   sqlite3 OK   ssl OK   asyncio OK   ctypes OK
  readline FAIL   curses FAIL   zoneinfo OK (with lib-arm64 on path)
sqlite version 3.51.0 threadsafety 1 / FTS5 OK / FTS5 trigram OK / enable_load_extension: False / WAL OK
ssl OpenSSL 3.0.22
asyncio loopback roundtrip: b'echo:hi\n'
thread-loop OK / signal.signal from thread raises: ValueError
subprocess.run raises: OSError [Errno 45] ios does not support processes.

uvicorn loop impl: auto http: auto ws: auto bound port 62175
HTTP: {"ok": true, "platform": "ios", "path": "/api/status"}
WS: ws-echo:hello
uvicorn shutdown clean: True

hermes_constants OK
hermes_state import OK in 1.29s
SessionDB: SessionDB
create_session -> ios-e239b9d9
append_message -> 1
get_session -> {'id': 'ios-e239b9d9', 'source': 'ios-probe', 'model': 'local/qwen3-4b', 'message_count': 2}
messages: [('user', 'hello from iOS'), ('assistant', 'hi back')]
home contents: ['SOUL.md', 'audio_cache', 'cache', 'cron', 'hooks', 'image_cache', 'logs', 'memories',
                'pairing', 'sessions', 'skills', 'state.db', 'state.db.fts_rebuild.lock', 'state.db.quarantine.lock']
```

**On-device cold-start measurement (Phase L0, 2026-09-07).** Device: iPhone 17 Pro Max (iPhone18,2), iOS 26. Build: Debug with full Python layer bundled (stdlib 15 MB, app_packages 61 MB, hermes 75 MB — 151 MB total), HERMES_LOCAL_MODE enabled, code-signed with automatic provisioning. Measured via `xcrun devicectl device process launch --console` after a clean process termination. Result: **process creation to "WebView loaded" in <200 ms** (first log at 19:27:55.419, WebView loaded at same timestamp, first Capacitor plugin calls at 19:27:55.563). Well under the 6 s target. Note: Python interpreter startup is not yet measured separately — this measures the Capacitor shell cold start with the Python bundle present as resources. The "Could not connect to server" errors are expected (no gateway running — local-mode runtime is Phase L0's build artifact, not yet wired for launch).

**Bundle-size measurements (Phase L0, 2026-09-07).** Python.xcframework (BeeWare 3.13-b15): 116 MB on disk (device 25 MB, simulator 41 MB, shared stdlib 50 MB including test/). Bundled stdlib after pruning test/tkinter/turtledemo and .pyc precompile with .py strip: **16 MB**. Hermes Python tree (pruned: tests, apps, web, website, docs, evals, ui-tui, node_modules, mcp-research-data, gateway/platforms): **39 MB**. Total Python layer without app_packages: **55 MB**. Estimated with app_packages (44 pure-Python + Pillow + cffi/ruamel + 3 cross-builds): ~100–130 MB.

**Spawn audit (Phase L0, 2026-09-07).** Static analysis of all `subprocess.run`, `subprocess.Popen`, `subprocess.call`, `subprocess.check_output`, `os.system`, `os.execvp` call sites in the upstream tree at pin `f159e581c7`. Total: **487 call sites** across 95 files.

Classification by reachability from the iOS boot + chat path:

| Category | Count | Examples | On iOS |
|---|---|---|---|
| Desktop/platform management (`gateway.py`, `main_desktop.py`, `managed_uv.py`, `update_cmd*.py`, `profiles.py`) | ~180 | launchctl, systemctl, pip, git clone, electron | Never reached — `hermes serve` does not call `cmd_dashboard`'s management layer |
| Disabled toolsets: terminal, code_execution, browser, computer_use (`tools/terminal_tool*.py`, `tools/code_*.py`, `tools/browser_tool*.py`, `tools/computer_use/*.py`) | ~90 | shell commands, kernel spawn, Chromium launch | Disabled by `ios_config.yaml` toolset list |
| Messaging/platform adapters (`plugins/platforms/*`, `gateway/platforms/*`) | ~50 | Discord, Telegram, WhatsApp bridges | Not started — `hermes serve` never runs `gateway run` |
| Agent infrastructure — lazy/optional (`agent/lsp/*`, `agent/secret_sources/*`, `agent/proxy_sources/*`, `agent/copilot_acp_client.py`) | ~40 | LSP servers, 1Password, Iron proxy, Copilot | Not configured on mobile; fail at `OSError(45)` |
| Agent infrastructure — reachable on chat path (`agent/shell_hooks.py`, `agent/coding_context.py`, `agent/context_references.py`, `agent/verify/runner.py`) | ~15 | git blame, git diff, shell hooks, verify scripts | Fail gracefully: `OSError(45)` caught by existing `try/except OSError` wrappers (the same guards added for Windows) |
| TUI host supervisor (`tui_gateway/host_supervisor.py`, `tui_gateway/server.py`) | ~12 | Agent subprocess for stdio TUI | Not used — web serve runs the agent as threads via `tui_gateway.ws.handle_ws`, not subprocess |
| Web server routes (`web_routers/tools.py`, `web_routers/git.py`, `web_routers/actions.py`) | ~8 | Tool execution, git status, background actions | Tool routes guarded by toolset config; git routes return errors |
| Boot path (`hermes_cli/web_server.py::start_server`) | **0** | — | start_server is purely in-process: `asyncio.run(uvicorn.Server.serve())` |
| Chat happy path (WS → dispatch → AIAgent → model API → stream) | **0** | — | In-process async with no subprocess involvement |

**Conclusion: zero subprocess calls on the boot path, zero on the chat happy path.** All reachable subprocess sites on the chat path are either (a) disabled by toolset configuration (`ios_config.yaml`), (b) caught by existing `try/except OSError` guards (inherited from Windows compat work in `_subprocess_compat.py`), or (c) in code paths never invoked by `hermes serve` (desktop management, platform adapters, TUI subprocess supervision). The debug `Popen` wrapper in `hermes_mobile_boot.py` will log any unexpected spawn attempt in debug builds; release builds rely on the native `OSError [Errno 45]`.

**Size inputs.** Hermes Python tree copied for the probe (everything except tests/apps/web/website/docs/node_modules/venv/.git/evals/ui-tui/mcp-research-data): 63 MB; chat-relevant packages only: `hermes_cli` 8.7 MB, `agent` 5.0, `tools` 4.5, `gateway` 4.0, `plugins` 4.2, `tui_gateway` 1.2, `cron` 0.6, root 1.4. Core site-packages on the Mac venv: 84 MB including `nemo_relay` 26 MB and `anydoc` 6.9 MB, both omitted on iOS.

**Local inference references.** `hermes_cli/local_runtime/detect.py` (`/props` fingerprint, port 8080); `plugins/model-providers/custom/__init__.py` (`CustomProfile`, Ollama/llama.cpp/vLLM by `base_url`); `hermes_cli/runtime_provider_backends.py` (`CUSTOM_BASE_URL` precedence); `tui_gateway/methods_config.py` (`setup.runtime_check` accepts `no-key-required`). iPhone benchmark figures from `john-rocky/apple-silicon-llm-bench` (iPhone 17 Pro: Gemma 4 E2B — MLX 49.1 tok/s @3,010 MB, llama.cpp Q4_K_M 38.8 tok/s @191 MB resident; Qwen3.5 2B — MLX 61.2 tok/s @1,279 MB, llama.cpp 39.1 tok/s @1,479 MB). Models: `mlx-community/Hermes-3-Llama-3.2-3B-{4bit,8bit}`, `NousResearch/Hermes-3-Llama-3.2-3B-GGUF`, `mlx-community/Qwen3-4B-4bit`. Frameworks: `ml-explore/mlx-swift-lm` (MLXLLM/MLXLMCommon), `SharpAI/SwiftLM` (MIT; MLX Swift + Hummingbird OpenAI-compatible server with an iPhone app), Apple `FoundationModels` (iOS 26, `Tool` protocol, `streamResponse`).
