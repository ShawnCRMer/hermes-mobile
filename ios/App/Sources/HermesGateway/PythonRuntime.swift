import Foundation
import UIKit

/// Embeds CPython 3.13 and runs `hermes serve` on a background thread.
/// The gateway binds to 127.0.0.1:<random port> and publishes the port
/// through a ready file, which the bridge reads to connect.
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
        let progress: Int      // 0–100
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

    private init() {}

    // MARK: - Public API

    func start() {
        guard phase == .idle || phase == .error else { return }
        updatePhase(.interpreter, progress: 5, message: "Starting interpreter…")

        sessionToken = UUID().uuidString
        let hermesHome = Self.hermesHomePath()
        let readyFilePath = Self.readyFilePath()

        // Clean stale ready file
        try? FileManager.default.removeItem(atPath: readyFilePath)

        pythonThread = Thread {
            self.runPython(
                hermesHome: hermesHome,
                readyFilePath: readyFilePath,
                token: self.sessionToken
            )
        }
        pythonThread?.name = "hermes-python"
        pythonThread?.qualityOfService = .userInitiated
        pythonThread?.start()

        // Poll for the ready file
        pollForReady(at: readyFilePath)
    }

    func stop() {
        callPythonShutdown()
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

    static func hermesHomePath() -> String {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!.path
        return (appSupport as NSString).appendingPathComponent("hermes")
    }

    static func readyFilePath() -> String {
        let caches = FileManager.default.urls(
            for: .cachesDirectory,
            in: .userDomainMask
        ).first!.path
        return (caches as NSString).appendingPathComponent("hermes-ready.json")
    }

    static func pythonHomePath() -> String {
        Bundle.main.path(forResource: "python", ofType: nil, inDirectory: nil)
            ?? (Bundle.main.bundlePath as NSString).appendingPathComponent("python")
    }

    static func certFilePath() -> String {
        let packages = (pythonHomePath() as NSString).appendingPathComponent("app_packages")
        return (packages as NSString).appendingPathComponent("certifi/cacert.pem")
    }

    // MARK: - Python execution

    private func runPython(hermesHome: String, readyFilePath: String, token: String) {
        // All env vars must be set BEFORE Py_Initialize (ADR-002 D1)
        let pythonHome = Self.pythonHomePath()
        let pythonPath = [
            (pythonHome as NSString).appendingPathComponent("stdlib"),
            (pythonHome as NSString).appendingPathComponent("app_packages"),
            (pythonHome as NSString).appendingPathComponent("hermes"),
        ].joined(separator: ":")

        setenv("PYTHONHOME", pythonHome, 1)
        setenv("PYTHONPATH", pythonPath, 1)
        setenv("PYTHONUTF8", "1", 1)
        setenv("PYTHONDONTWRITEBYTECODE", "1", 1)
        setenv("PYTHONUNBUFFERED", "1", 1)
        setenv("HERMES_HOME", hermesHome, 1)
        setenv("HERMES_SERVE_HEADLESS", "1", 1)
        setenv("HERMES_DESKTOP_READY_FILE", readyFilePath, 1)
        setenv("HERMES_DASHBOARD_SESSION_TOKEN", token, 1)
        setenv("SSL_CERT_FILE", Self.certFilePath(), 1)

        #if DEBUG
        setenv("HERMES_MOBILE_DEBUG", "1", 1)
        #endif

        // DO NOT set HERMES_DESKTOP=1 — it enables orphan reaper + cron ticker

        DispatchQueue.main.async {
            self.updatePhase(.interpreter, progress: 10, message: "Initializing Python…")
        }

        // --- CPython initialization ---
        // NOTE: This calls the CPython C API.
        // The actual C interop requires a bridging header or a Swift module map
        // for Python.framework. The calls below are the logical sequence;
        // the real implementation links against Python.xcframework.

        guard initializePython() else {
            DispatchQueue.main.async {
                self.updatePhase(.error, progress: 0, message: "Failed to initialize Python")
            }
            return
        }

        DispatchQueue.main.async {
            self.updatePhase(.imports, progress: 30, message: "Loading Hermes modules…")
        }

        // Import boot module, then start the server
        let script = """
        import hermes_mobile_boot
        from hermes_cli.web_server import start_server
        server = start_server(host="127.0.0.1", port=0, open_browser=False, headless=True)
        hermes_mobile_boot.set_server(server)
        """

        guard runPythonString(script) else {
            DispatchQueue.main.async {
                self.updatePhase(.error, progress: 0, message: "Failed to start Hermes gateway")
            }
            return
        }
    }

    // MARK: - CPython C API wrappers

    /// Initialize the Python interpreter.
    /// Links against Python.xcframework via the bridging header.
    private func initializePython() -> Bool {
        // Py_InitializeFromConfig with:
        //   use_system_logger = 1
        //   buffered_stdio = 0
        //   write_bytecode = 0
        //   install_signal_handlers = 1
        //
        // The actual C calls are:
        //   var config = PyConfig()
        //   PyConfig_InitIsolatedConfig(&config)
        //   config.use_system_logger = 1
        //   config.buffered_stdio = 0
        //   config.write_bytecode = 0
        //   config.install_signal_handlers = 1
        //   let status = Py_InitializeFromConfig(&config)
        //   PyConfig_Clear(&config)
        //   return PyStatus_IsError(status) == 0
        //
        // Stubbed here — the real implementation requires the Python.h bridging header
        // which is added when Python.xcframework is linked to the Xcode project.
        // See: ios/App/App-Bridging-Header.h

        #if canImport(PythonKit)
        // PythonKit path (alternative)
        return true
        #else
        // Direct C API — requires bridging header
        // The function bodies are filled in once Python.xcframework is linked.
        return _pyInitialize()
        #endif
    }

    /// Run a Python string in the interpreter.
    private func runPythonString(_ code: String) -> Bool {
        // PyRun_SimpleString(code)
        // Returns 0 on success, -1 on error
        return _pyRunString(code)
    }

    /// Call hermes_mobile_boot.request_shutdown()
    private func callPythonShutdown() {
        _ = _pyRunString("import hermes_mobile_boot; hermes_mobile_boot.request_shutdown()")
    }

    // MARK: - C API stubs (replaced when Python.xcframework is linked)

    // These are placeholders. The real implementation uses @_silgen_name or
    // a bridging header to call Py_InitializeFromConfig / PyRun_SimpleString.
    // They are separated so the Swift code compiles without Python.xcframework
    // present, and the linker resolves them when the framework is added.

    private func _pyInitialize() -> Bool {
        // Will be replaced by actual CPython C API calls
        fatalError("Python.xcframework not linked — run scripts/fetch-python-framework.sh")
    }

    private func _pyRunString(_ code: String) -> Bool {
        // Will be replaced by actual CPython C API calls
        fatalError("Python.xcframework not linked — run scripts/fetch-python-framework.sh")
    }

    // MARK: - Ready file polling

    private func pollForReady(at path: String) {
        DispatchQueue.main.async {
            self.updatePhase(.bind, progress: 60, message: "Waiting for gateway…")
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let start = Date()
            let timeout: TimeInterval = 30

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
                Thread.sleep(forTimeInterval: 0.2)
            }

            DispatchQueue.main.async {
                self.updatePhase(.error, progress: 0, message: "Gateway did not start within \(Int(timeout))s")
            }
        }
    }

    // MARK: - Progress

    private func updatePhase(_ phase: Phase, progress: Int, message: String) {
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
