import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private var thermalObserver: NSObjectProtocol?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        #if HERMES_LOCAL_MODE
        startLocalModeIfEnabled()
        observeThermalState()
        #endif
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        PythonRuntime.shared.beginBackgroundTask()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        PythonRuntime.shared.endBackgroundTask()
        if PythonRuntime.shared.phase == .ready && !PythonRuntime.shared.isAlive {
            PythonRuntime.shared.stop()
            PythonRuntime.shared.start()
        }
        if !LocalInferenceServer.shared.isRunning {
            LocalInferenceServer.shared.start()
        }
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
    }

    func applicationWillTerminate(_ application: UIApplication) {
        LocalInferenceServer.shared.stop()
        PythonRuntime.shared.stop()
    }

    func applicationDidReceiveMemoryWarning(_ application: UIApplication) {
        ModelStore.shared.unloadModel()
        LocalInferenceServer.shared.setEngine(nil)
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // MARK: - Local mode

    #if HERMES_LOCAL_MODE
    private func startLocalModeIfEnabled() {
        PythonRuntime.shared.start()
        LocalInferenceServer.shared.start()
    }

    private func observeThermalState() {
        thermalObserver = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification,
            object: nil,
            queue: .main
        ) { _ in
            let state = ProcessInfo.processInfo.thermalState
            if state == .serious || state == .critical {
                ModelStore.shared.unloadModel()
                LocalInferenceServer.shared.setEngine(nil)
            }
        }
    }
    #endif
}
