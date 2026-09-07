import Foundation
import UIKit

/// Embeds CPython 3.13 and runs `hermes serve` on a background thread.
///
/// Requires:
/// - Python.xcframework linked to the App target
/// - SWIFT_OBJC_BRIDGING_HEADER = App/App-Bridging-Header.h
/// - HERMES_LOCAL_MODE added to SWIFT_ACTIVE_COMPILATION_CONDITIONS
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
        let token = sessionToken

        try? FileManager.default.removeItem(atPath: readyFilePath)

        pythonThread = Thread {
            self.runPython(
                hermesHome: hermesHome,
                readyFilePath: readyFilePath,
                token: token
            )
        }
        pythonThread?.name = "hermes-python"
        pythonThread?.qualityOfService = .userInitiated
        pythonThread?.start()

        pollForReady(at: readyFilePath)
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

    nonisolated static func readyFilePath() -> String {
        let caches = FileManager.default.urls(
            for: .cachesDirectory,
            in: .userDomainMask
        ).first!.path
        return (caches as NSString).appendingPathComponent("hermes-ready.json")
    }

    nonisolated static func pythonHomePath() -> String {
        Bundle.main.path(forResource: "python", ofType: nil)
            ?? (Bundle.main.bundlePath as NSString).appendingPathComponent("python")
    }

    nonisolated static func certFilePath() -> String {
        let packages = (pythonHomePath() as NSString).appendingPathComponent("app_packages")
        return (packages as NSString).appendingPathComponent("certifi/cacert.pem")
    }

    // MARK: - Python execution

    #if HERMES_LOCAL_MODE

    // nonisolated because this runs on the background pythonThread
    nonisolated private func runPython(hermesHome: String, readyFilePath: String, token: String) {
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

        DispatchQueue.main.async { @MainActor in
            self.updatePhase(.interpreter, progress: 10, message: "Initializing Python…")
        }

        var preConfig = PyPreConfig()
        PyPreConfig_InitIsolatedConfig(&preConfig)
        preConfig.utf8_mode = 1
        Py_PreInitialize(&preConfig)

        var config = PyConfig()
        PyConfig_InitIsolatedConfig(&config)
        config.buffered_stdio = 0
        config.write_bytecode = 0
        config.install_signal_handlers = 1

        let status = Py_InitializeFromConfig(&config)
        PyConfig_Clear(&config)

        if PyStatus_Exception(status) != 0 {
            let msg = status.err_msg.map { String(cString: $0) } ?? "unknown error"
            DispatchQueue.main.async { @MainActor in
                self.updatePhase(.error, progress: 0, message: "Python init failed: \(msg)")
            }
            return
        }

        DispatchQueue.main.async { @MainActor in
            self.updatePhase(.imports, progress: 30, message: "Loading Hermes modules…")
        }

        let script = """
        import hermes_mobile_boot
        from hermes_cli.web_server import start_server
        server = start_server(host="127.0.0.1", port=0, open_browser=False, headless=True)
        hermes_mobile_boot.set_server(server)
        """

        let result = script.withCString { PyRun_SimpleString($0) }

        if result != 0 {
            DispatchQueue.main.async { @MainActor in
                self.updatePhase(.error, progress: 0, message: "Failed to start Hermes gateway")
            }
        }
    }

    nonisolated private func callPythonShutdown() {
        _ = "import hermes_mobile_boot; hermes_mobile_boot.request_shutdown()".withCString {
            PyRun_SimpleString($0)
        }
    }

    #endif

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
