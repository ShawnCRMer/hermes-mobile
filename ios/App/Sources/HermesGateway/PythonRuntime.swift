import Foundation
import UIKit

/// Embeds CPython 3.13 and runs `hermes serve` on a background thread.
///
/// Requires:
/// - Python.xcframework linked to the App target
/// - SWIFT_OBJC_BRIDGING_HEADER = App/App-Bridging-Header.h
/// - HERMES_LOCAL_MODE added to SWIFT_ACTIVE_COMPILATION_CONDITIONS
/// - The "Prepare Python Binary Modules" build phase
///   (scripts/xcode-prepare-python-modules.sh), which relocates the
///   python/ layer's extension modules into signed frameworks per platform.
///
/// Without HERMES_LOCAL_MODE, start() reports local mode unavailable
/// and the app runs in remote-only mode.
@MainActor
final class PythonRuntime {

    enum Phase: String, Sendable {
        case idle
        case interpreter
        case imports
        case bind
        case ready
        case error
    }

    struct BootProgress: Sendable {
        let phase: Phase
        let progress: Int
        let message: String
        let error: String?
    }

    static let shared = PythonRuntime()

    private(set) var phase: Phase = .idle
    private(set) var boundPort: UInt16 = 0
    private(set) var sessionToken: String = ""
    private(set) var lastError: String?

    private var pythonThread: Thread?
    private var backgroundTaskID: UIBackgroundTaskIdentifier = .invalid

    var onProgressChanged: ((BootProgress) -> Void)?

    var localModeAvailable: Bool {
        #if HERMES_LOCAL_MODE
        return true
        #else
        return false
        #endif
    }

    private init() {}

    // MARK: - Public API

    func start() {
        guard phase == .idle || phase == .error else { return }

        #if HERMES_LOCAL_MODE
        updatePhase(.interpreter, progress: 5, message: "Starting interpreter…")

        sessionToken = UUID().uuidString
        let hermesHome = Self.hermesHomePath()
        let readyFilePath = Self.readyFilePath()
        let errorFilePath = Self.bootErrorFilePath()
        let token = sessionToken

        try? FileManager.default.removeItem(atPath: readyFilePath)
        try? FileManager.default.removeItem(atPath: errorFilePath)

        let thread = Thread {
            self.runPython(
                hermesHome: hermesHome,
                readyFilePath: readyFilePath,
                errorFilePath: errorFilePath,
                token: token
            )
        }
        thread.name = "hermes-python"
        thread.qualityOfService = .userInitiated
        // Secondary threads default to a 512 KB stack on iOS. Importing the
        // Hermes tree (pydantic model construction, deep decorator chains)
        // recurses far deeper than that and would crash with EXC_BAD_ACCESS
        // instead of raising a Python error we can report.
        thread.stackSize = 16 * 1024 * 1024
        pythonThread = thread
        thread.start()

        pollForReady(at: readyFilePath, errorFile: errorFilePath, thread: thread)
        #else
        updatePhase(.error, progress: 0, message: "Local mode not available — build with HERMES_LOCAL_MODE")
        #endif
    }

    func stop() {
        #if HERMES_LOCAL_MODE
        callPythonShutdown()
        #endif
        phase = .idle
        boundPort = 0
    }

    var isAlive: Bool {
        guard phase == .ready, let thread = pythonThread else { return false }
        return !thread.isCancelled
    }

    var baseUrl: String {
        "http://127.0.0.1:\(boundPort)"
    }

    // MARK: - Background task support

    func beginBackgroundTask() {
        guard backgroundTaskID == .invalid else { return }
        backgroundTaskID = UIApplication.shared.beginBackgroundTask(withName: "hermes-turn") {
            self.endBackgroundTask()
        }
    }

    func endBackgroundTask() {
        guard backgroundTaskID != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTaskID)
        backgroundTaskID = .invalid
    }

    // MARK: - Paths

    nonisolated static func hermesHomePath() -> String {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!.path
        return (appSupport as NSString).appendingPathComponent("hermes")
    }

    nonisolated private static func cachesPath() -> String {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!.path
    }

    nonisolated static func readyFilePath() -> String {
        (cachesPath() as NSString).appendingPathComponent("hermes-ready.json")
    }

    /// Written by the boot script when any step before the server binds
    /// raises; carries the full Python traceback.
    nonisolated static func bootErrorFilePath() -> String {
        (cachesPath() as NSString).appendingPathComponent("hermes-boot-error.txt")
    }

    /// Python's stdout/stderr are redirected here by the boot script so the
    /// gateway log survives when the app is not attached to Xcode.
    nonisolated static func pythonLogFilePath() -> String {
        (cachesPath() as NSString).appendingPathComponent("hermes-python.log")
    }

    nonisolated static func pythonHomePath() -> String {
        Bundle.main.path(forResource: "python", ofType: nil)
            ?? (Bundle.main.bundlePath as NSString).appendingPathComponent("python")
    }

    /// sys.path, in order. lib-dynload is populated per platform by the
    /// "Prepare Python Binary Modules" build phase.
    nonisolated static func moduleSearchPaths() -> [String] {
        let home = pythonHomePath() as NSString
        let stdlib = home.appendingPathComponent("stdlib") as NSString
        return [
            stdlib as String,
            stdlib.appendingPathComponent("lib-dynload"),
            home.appendingPathComponent("app_packages"),
            home.appendingPathComponent("hermes"),
        ]
    }

    nonisolated static func certFilePath() -> String {
        let packages = (pythonHomePath() as NSString).appendingPathComponent("app_packages")
        return (packages as NSString).appendingPathComponent("certifi/cacert.pem")
    }

    // MARK: - Python execution

    #if HERMES_LOCAL_MODE

    // nonisolated because this runs on the background pythonThread
    nonisolated private func runPython(hermesHome: String, readyFilePath: String, errorFilePath: String, token: String) {
        let pythonHome = Self.pythonHomePath()
        let searchPaths = Self.moduleSearchPaths()

        // Process environment read by Hermes at Python level. NOTE: PYTHON*
        // variables are deliberately NOT used — PyConfig_InitIsolatedConfig
        // sets use_environment = 0, so PYTHONHOME/PYTHONPATH would be
        // ignored. The interpreter location and sys.path are configured
        // explicitly through PyConfig below instead.
        setenv("HERMES_HOME", hermesHome, 1)
        setenv("HERMES_SERVE_HEADLESS", "1", 1)
        setenv("HERMES_DESKTOP_READY_FILE", readyFilePath, 1)
        setenv("HERMES_DASHBOARD_SESSION_TOKEN", token, 1)
        setenv("HERMES_MOBILE_BOOT_ERROR_FILE", errorFilePath, 1)
        setenv("HERMES_MOBILE_LOG_FILE", Self.pythonLogFilePath(), 1)
        setenv("SSL_CERT_FILE", Self.certFilePath(), 1)

        #if DEBUG
        setenv("HERMES_MOBILE_DEBUG", "1", 1)
        #endif

        // Sanity-check the layer before touching the interpreter so a broken
        // bundle produces a readable message instead of a getpath failure.
        for path in [searchPaths[0], searchPaths[2], searchPaths[3]] {
            var isDir: ObjCBool = false
            if !FileManager.default.fileExists(atPath: path, isDirectory: &isDir) || !isDir.boolValue {
                self.fail("Python layer missing: \(path). Run scripts/build-python-layer.sh and rebuild.")
                return
            }
        }

        DispatchQueue.main.async { @MainActor in
            self.updatePhase(.interpreter, progress: 10, message: "Initializing Python…")
        }

        // The interpreter can only be initialised once per process; a retry
        // after an earlier boot failure re-runs the boot script only.
        if Py_IsInitialized() == 0 {
            var preConfig = PyPreConfig()
            PyPreConfig_InitIsolatedConfig(&preConfig)
            preConfig.utf8_mode = 1
            let preStatus = Py_PreInitialize(&preConfig)
            if PyStatus_Exception(preStatus) != 0 {
                self.fail("Python pre-initialization failed: \(Self.describe(preStatus))")
                return
            }

            var config = PyConfig()
            PyConfig_InitIsolatedConfig(&config)
            config.buffered_stdio = 0
            config.write_bytecode = 0
            // We are not on the main thread and never want Python to own
            // SIGINT; uvicorn installs what it needs itself.
            config.install_signal_handlers = 0
            // Owned by config; PyConfig_Clear frees it (Py_DecodeLocale
            // allocates with PyMem_RawMalloc, which is what it expects).
            config.home = Py_DecodeLocale(pythonHome, nil)
            config.module_search_paths_set = 1
            for path in searchPaths {
                guard let wide = Py_DecodeLocale(path, nil) else {
                    PyConfig_Clear(&config)
                    self.fail("Could not encode sys.path entry: \(path)")
                    return
                }
                let appendStatus = PyWideStringList_Append(&config.module_search_paths, wide)
                PyMem_RawFree(wide)
                if PyStatus_Exception(appendStatus) != 0 {
                    PyConfig_Clear(&config)
                    self.fail("Could not configure sys.path: \(Self.describe(appendStatus))")
                    return
                }
            }

            let status = Py_InitializeFromConfig(&config)
            PyConfig_Clear(&config)

            if PyStatus_Exception(status) != 0 {
                self.fail("Python init failed: \(Self.describe(status)) (home=\(pythonHome))")
                return
            }
        }

        DispatchQueue.main.async { @MainActor in
            self.updatePhase(.imports, progress: 30, message: "Loading Hermes modules…")
        }

        // Any exception before the server binds is written verbatim to the
        // error file; pollForReady() picks it up and surfaces it. stdout and
        // stderr are tee'd to a log file so the gateway's own logging is
        // retrievable from the device (Files app / Xcode container download).
        let script = """
        import os, sys, traceback
        _err_path = os.environ.get("HERMES_MOBILE_BOOT_ERROR_FILE")
        _log_path = os.environ.get("HERMES_MOBILE_LOG_FILE")

        def _report(exc_text):
            try:
                if _err_path:
                    with open(_err_path, "w", encoding="utf-8") as fh:
                        fh.write(exc_text)
            except Exception:
                pass
            sys.__stderr__.write(exc_text)

        try:
            if _log_path:
                class _Tee:
                    def __init__(self, *streams):
                        self._streams = streams
                    def write(self, data):
                        for s in self._streams:
                            try:
                                s.write(data)
                            except Exception:
                                pass
                        return len(data)
                    def flush(self):
                        for s in self._streams:
                            try:
                                s.flush()
                            except Exception:
                                pass
                    def isatty(self):
                        return False
                    @property
                    def encoding(self):
                        return "utf-8"
                    def fileno(self):
                        return self._streams[0].fileno()
                _log_fh = open(_log_path, "a", encoding="utf-8", buffering=1)
                sys.stdout = _Tee(sys.__stdout__, _log_fh)
                sys.stderr = _Tee(sys.__stderr__, _log_fh)
                print("--- hermes-mobile python boot", sys.version.split()[0], sys.platform, "---")
            import hermes_mobile_boot
            from hermes_cli.web_server import start_server
        except BaseException:
            _report(traceback.format_exc())
            raise

        try:
            server = start_server(host="127.0.0.1", port=0, open_browser=False, headless=True)
            hermes_mobile_boot.set_server(server)
        except SystemExit as exc:
            _report("start_server exited with status %r before binding\\n%s" % (exc.code, traceback.format_exc()))
            raise
        except BaseException:
            _report(traceback.format_exc())
            raise
        """

        let result = script.withCString { PyRun_SimpleString($0) }

        if result != 0 {
            // pollForReady() reports the traceback from the error file; this
            // only covers the case where nothing was written (e.g. the
            // interpreter refused to run the script at all).
            if !FileManager.default.fileExists(atPath: errorFilePath) {
                self.fail("Hermes gateway script exited with status \(result) without a traceback")
            }
        }
    }

    nonisolated private func callPythonShutdown() {
        guard Py_IsInitialized() != 0 else { return }
        _ = "import hermes_mobile_boot; hermes_mobile_boot.request_shutdown()".withCString {
            PyRun_SimpleString($0)
        }
    }

    nonisolated private static func describe(_ status: PyStatus) -> String {
        let msg = status.err_msg.map { String(cString: $0) } ?? "unknown error"
        let fn = status.`func`.map { String(cString: $0) }
        return fn.map { "\($0): \(msg)" } ?? msg
    }

    #endif

    // nonisolated so the background thread can report; hops to main to mutate.
    nonisolated private func fail(_ message: String) {
        NSLog("[PythonRuntime] %@", message)
        DispatchQueue.main.async { @MainActor in
            self.updatePhase(.error, progress: 0, message: message)
        }
    }

    // MARK: - Ready file polling

    private func pollForReady(at path: String, errorFile: String, thread: Thread) {
        DispatchQueue.main.async {
            self.updatePhase(.bind, progress: 60, message: "Waiting for gateway…")
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let start = Date()
            let timeout: TimeInterval = 60

            while Date().timeIntervalSince(start) < timeout {
                if let data = FileManager.default.contents(atPath: path),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let port = json["port"] as? Int, port > 0 {

                    try? FileManager.default.removeItem(atPath: path)

                    DispatchQueue.main.async {
                        self.boundPort = UInt16(port)
                        self.updatePhase(.ready, progress: 100, message: "Gateway ready on port \(port)")
                    }
                    return
                }

                if let data = FileManager.default.contents(atPath: errorFile),
                   let traceback = String(data: data, encoding: .utf8), !traceback.isEmpty {
                    try? FileManager.default.removeItem(atPath: errorFile)
                    self.fail(Self.summarize(traceback: traceback))
                    return
                }

                // The Python thread died without writing anything (interpreter
                // init failure already reported via fail()).
                if thread.isFinished {
                    // Give a traceback written in the same instant a chance to land.
                    Thread.sleep(forTimeInterval: 0.2)
                    if let data = FileManager.default.contents(atPath: errorFile),
                       let traceback = String(data: data, encoding: .utf8), !traceback.isEmpty {
                        try? FileManager.default.removeItem(atPath: errorFile)
                        self.fail(Self.summarize(traceback: traceback))
                    } else {
                        self.fail("Hermes gateway thread exited before the server bound (see hermes-python.log in the app's Caches)")
                    }
                    return
                }

                Thread.sleep(forTimeInterval: 0.2)
            }

            self.fail("Gateway did not start within \(Int(timeout))s (see hermes-python.log in the app's Caches)")
        }
    }

    /// Exception line first, then the last few frames, so the boot-failure
    /// overlay shows what broke without scrolling; the full text is in NSLog.
    nonisolated private static func summarize(traceback: String) -> String {
        NSLog("[PythonRuntime] boot traceback:\n%@", traceback)
        let lines = traceback.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        guard let last = lines.last else { return "Hermes gateway failed to start" }
        let tail = lines.suffix(8).dropLast().joined(separator: "\n")
        return "Hermes gateway failed to start: \(last)\n\n\(tail)"
    }

    // MARK: - Progress

    private func updatePhase(_ phase: Phase, progress: Int, message: String) {
        // A late error must not clobber a gateway that already came up
        // (e.g. the ready-file poller and the script both reporting).
        if self.phase == .ready && phase == .error { return }
        self.phase = phase
        self.lastError = phase == .error ? message : nil
        let p = BootProgress(
            phase: phase,
            progress: progress,
            message: message,
            error: phase == .error ? message : nil
        )
        onProgressChanged?(p)
    }
}
