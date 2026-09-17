import Foundation
import Capacitor

@objc(LocalGatewayPlugin)
class LocalGatewayPlugin: CAPPlugin, CAPBridgedPlugin {

    let identifier = "LocalGatewayPlugin"
    let jsName = "LocalGateway"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
    ]

    override func load() {
        Task { @MainActor in
            PythonRuntime.shared.onProgressChanged = { [weak self] progress in
                self?.pushProgress(progress)
            }
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        Task { @MainActor in
            let rt = PythonRuntime.shared
            call.resolve([
                "available": rt.localModeAvailable,
                "phase": rt.phase.rawValue,
                "port": Int(rt.boundPort),
                "token": rt.sessionToken,
                "error": rt.lastError as Any,
            ])
        }
    }

    private func pushProgress(_ progress: PythonRuntime.BootProgress) {
        notifyListeners("localGatewayProgress", data: [
            "phase": progress.phase.rawValue,
            "progress": progress.progress,
            "message": progress.message,
            "error": progress.error as Any,
        ])

        if progress.phase == .ready {
            Task { @MainActor in
                let rt = PythonRuntime.shared
                notifyListeners("localGatewayReady", data: [
                    "port": Int(rt.boundPort),
                    "token": rt.sessionToken,
                ])
            }
        }
    }
}
