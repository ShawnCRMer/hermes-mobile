import Foundation
import Capacitor

/// Capacitor plugin exposing model management to the WebView.
///
/// Bridge calls these methods via `Capacitor.Plugins.ModelManager.*`.
/// State changes are pushed to the WebView via `notifyListeners`.
@objc(ModelManagerPlugin)
class ModelManagerPlugin: CAPPlugin, CAPBridgedPlugin {

    let identifier = "ModelManagerPlugin"
    let jsName = "ModelManager"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "downloadModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setActiveModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getInferencePort", returnType: CAPPluginReturnPromise),
    ]

    override func load() {
        ModelStore.shared.onStateChanged = { [weak self] in
            self?.pushStatusUpdate()
        }

        LocalInferenceServer.shared.onStatusChanged = { [weak self] running, port in
            self?.notifyListeners("inferenceServerChanged", data: [
                "running": running,
                "port": port,
            ])
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        let store = ModelStore.shared
        let models = ModelStore.catalog.map { info -> [String: Any] in
            let state = store.modelStates[info.id] ?? .notDownloaded
            return [
                "id": info.id,
                "displayName": info.displayName,
                "huggingFaceRepo": info.huggingFaceRepo,
                "format": info.format.rawValue,
                "sizeBytes": info.sizeBytes,
                "tier": info.tier.rawValue,
                "contextLength": info.contextLength,
                "supportsTools": info.supportsTools,
                "state": stateDict(state),
            ]
        }

        call.resolve([
            "available": PythonRuntime.shared.localModeAvailable,
            "inferenceServerPort": LocalInferenceServer.shared.port,
            "inferenceServerRunning": LocalInferenceServer.shared.isRunning,
            "activeModelId": store.activeModelId ?? NSNull(),
            "models": models,
            "storageUsed": store.storageUsed(),
        ])
    }

    @objc func downloadModel(_ call: CAPPluginCall) {
        guard let modelId = call.getString("modelId") else {
            call.reject("modelId required")
            return
        }
        ModelStore.shared.download(modelId: modelId)
        call.resolve(["ok": true])
    }

    @objc func cancelDownload(_ call: CAPPluginCall) {
        guard let modelId = call.getString("modelId") else {
            call.reject("modelId required")
            return
        }
        ModelStore.shared.cancelDownload(modelId: modelId)
        call.resolve(["ok": true])
    }

    @objc func deleteModel(_ call: CAPPluginCall) {
        guard let modelId = call.getString("modelId") else {
            call.reject("modelId required")
            return
        }
        ModelStore.shared.deleteModel(modelId: modelId)
        call.resolve(["ok": true])
    }

    @objc func setActiveModel(_ call: CAPPluginCall) {
        let modelId = call.getString("modelId")
        ModelStore.shared.setActiveModel(modelId)
        call.resolve(["ok": true])
    }

    @objc func getInferencePort(_ call: CAPPluginCall) {
        call.resolve([
            "port": LocalInferenceServer.shared.port,
            "running": LocalInferenceServer.shared.isRunning,
        ])
    }

    // MARK: - Push updates

    private func pushStatusUpdate() {
        let store = ModelStore.shared
        var modelsData: [[String: Any]] = []
        for info in ModelStore.catalog {
            let state = store.modelStates[info.id] ?? .notDownloaded
            modelsData.append([
                "id": info.id,
                "state": stateDict(state),
            ])
        }

        notifyListeners("modelStatusChanged", data: [
            "activeModelId": store.activeModelId ?? NSNull(),
            "models": modelsData,
            "storageUsed": store.storageUsed(),
        ])
    }

    private func stateDict(_ state: ModelStore.ModelState) -> [String: Any] {
        switch state {
        case .notDownloaded:
            return ["status": "notDownloaded"]
        case .downloading(let progress):
            return ["status": "downloading", "progress": progress]
        case .downloaded:
            return ["status": "downloaded"]
        case .loading:
            return ["status": "loading"]
        case .loaded:
            return ["status": "loaded"]
        case .error(let msg):
            return ["status": "error", "message": msg]
        }
    }
}
