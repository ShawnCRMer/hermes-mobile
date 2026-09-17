import Foundation
import UIKit

/// Manages on-device model downloads, storage, and lifecycle.
///
/// Models are stored under `Application Support/models/<id>/` and excluded
/// from iCloud backup. Downloads use a background URLSession so they survive
/// app suspension.
@MainActor
final class ModelStore: NSObject {

    static let shared = ModelStore()

    // MARK: - Model catalog

    struct ModelInfo: Codable, Sendable {
        let id: String
        let displayName: String
        let huggingFaceRepo: String
        let format: ModelFormat
        let sizeBytes: Int64
        let tier: ModelTier
        let contextLength: Int
        let supportsTools: Bool
    }

    enum ModelFormat: String, Codable, Sendable {
        case mlx
        case gguf
    }

    enum ModelTier: String, Codable, Sendable {
        case `default`
        case onBrand
        case fast
        case efficient
        case zeroDownload
    }

    enum ModelState: Sendable {
        case notDownloaded
        case downloading(progress: Double)
        case downloaded
        case loading
        case loaded
        case error(String)
    }

    static let catalog: [ModelInfo] = [
        ModelInfo(
            id: "qwen3-4b-4bit",
            displayName: "Qwen3 4B",
            huggingFaceRepo: "mlx-community/Qwen3-4B-4bit",
            format: .mlx,
            sizeBytes: 2_500_000_000,
            tier: .default,
            contextLength: 131072,
            supportsTools: true
        ),
        ModelInfo(
            id: "hermes-3-llama-3.2-3b-4bit",
            displayName: "Hermes 3 3B",
            huggingFaceRepo: "mlx-community/Hermes-3-Llama-3.2-3B-4bit",
            format: .mlx,
            sizeBytes: 1_800_000_000,
            tier: .onBrand,
            contextLength: 131072,
            supportsTools: true
        ),
        ModelInfo(
            id: "qwen3-1.7b-4bit",
            displayName: "Qwen3 1.7B",
            huggingFaceRepo: "mlx-community/Qwen3-1.7B-4bit",
            format: .mlx,
            sizeBytes: 1_000_000_000,
            tier: .fast,
            contextLength: 131072,
            supportsTools: true
        ),
        ModelInfo(
            id: "gemma-3n-e2b-4bit",
            displayName: "Gemma 3n E2B",
            huggingFaceRepo: "mlx-community/gemma-3n-E2B-it-4bit",
            format: .mlx,
            sizeBytes: 1_600_000_000,
            tier: .efficient,
            contextLength: 131072,
            supportsTools: true
        ),
    ]

    // MARK: - State

    private(set) var modelStates: [String: ModelState] = [:]
    private(set) var activeModelId: String?

    var onStateChanged: (() -> Void)?

    private var downloadSession: URLSession!
    private var activeDownloads: [String: DownloadTask] = [:]

    private struct DownloadTask {
        let modelId: String
        var completedFiles: Int
        var totalFiles: Int
        var bytesWritten: Int64
        var totalBytes: Int64
    }

    // MARK: - Init

    private override init() {
        super.init()
        let config = URLSessionConfiguration.background(withIdentifier: "com.mobilehermes.modeldownload")
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        downloadSession = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        scanDownloadedModels()
    }

    // MARK: - Paths

    nonisolated static func modelsDirectory() -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("models", isDirectory: true)
    }

    nonisolated func modelDirectory(for id: String) -> URL {
        Self.modelsDirectory().appendingPathComponent(id, isDirectory: true)
    }

    // MARK: - Scan existing

    private func scanDownloadedModels() {
        let dir = Self.modelsDirectory()
        guard let entries = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else {
            for model in Self.catalog { modelStates[model.id] = .notDownloaded }
            return
        }
        let downloadedIds = Set(entries.map(\.lastPathComponent))
        for model in Self.catalog {
            if downloadedIds.contains(model.id) {
                let configPath = modelDirectory(for: model.id).appendingPathComponent("config.json")
                modelStates[model.id] = FileManager.default.fileExists(atPath: configPath.path) ? .downloaded : .notDownloaded
            } else {
                modelStates[model.id] = .notDownloaded
            }
        }
    }

    // MARK: - Download

    func download(modelId: String) {
        guard let model = Self.catalog.first(where: { $0.id == modelId }) else { return }
        guard case .notDownloaded = modelStates[modelId] ?? .notDownloaded else { return }

        modelStates[modelId] = .downloading(progress: 0)
        onStateChanged?()

        let dest = modelDirectory(for: modelId)
        try? FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        excludeFromBackup(dest)

        Task {
            await startHuggingFaceDownload(model: model)
        }
    }

    private func startHuggingFaceDownload(model: ModelInfo) async {
        let repo = model.huggingFaceRepo
        let apiUrl = "https://huggingface.co/api/models/\(repo)"

        guard let url = URL(string: apiUrl) else {
            modelStates[model.id] = .error("Invalid repo URL")
            onStateChanged?()
            return
        }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let siblings = json["siblings"] as? [[String: Any]] else {
                modelStates[model.id] = .error("Failed to fetch file list")
                onStateChanged?()
                return
            }

            let filenames = siblings.compactMap { $0["rfilename"] as? String }
            let needed = filenames.filter { name in
                name.hasSuffix(".safetensors") ||
                name.hasSuffix(".json") ||
                name == "tokenizer.model" ||
                name.hasSuffix(".py") ||
                name.hasSuffix(".tiktoken")
            }

            activeDownloads[model.id] = DownloadTask(
                modelId: model.id,
                completedFiles: 0,
                totalFiles: needed.count,
                bytesWritten: 0,
                totalBytes: model.sizeBytes
            )

            for filename in needed {
                let fileUrl = URL(string: "https://huggingface.co/\(repo)/resolve/main/\(filename)")!
                let request = URLRequest(url: fileUrl)
                let task = downloadSession.downloadTask(with: request)
                task.taskDescription = "\(model.id)|\(filename)"
                task.resume()
            }
        } catch {
            modelStates[model.id] = .error("Network error: \(error.localizedDescription)")
            onStateChanged?()
        }
    }

    func cancelDownload(modelId: String) {
        downloadSession.getTasksWithCompletionHandler { _, _, downloads in
            for task in downloads where task.taskDescription?.hasPrefix(modelId) == true {
                task.cancel()
            }
        }
        activeDownloads.removeValue(forKey: modelId)
        modelStates[modelId] = .notDownloaded
        onStateChanged?()

        let dir = modelDirectory(for: modelId)
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: - Delete

    func deleteModel(modelId: String) {
        if activeModelId == modelId { unloadModel() }
        let dir = modelDirectory(for: modelId)
        try? FileManager.default.removeItem(at: dir)
        modelStates[modelId] = .notDownloaded
        onStateChanged?()
    }

    // MARK: - Load / unload

    func setActiveModel(_ modelId: String?) async {
        if let oldId = activeModelId, oldId != modelId {
            if case .loaded = modelStates[oldId] {
                modelStates[oldId] = .downloaded
            }
        }

        activeModelId = modelId

        guard let modelId = modelId,
              Self.catalog.contains(where: { $0.id == modelId }),
              case .downloaded = modelStates[modelId] ?? .notDownloaded else {
            LocalInferenceServer.shared.setEngine(nil)
            onStateChanged?()
            return
        }

        modelStates[modelId] = .loading
        onStateChanged?()

        let engine = MLXInferenceEngine()
        let modelPath = modelDirectory(for: modelId)

        do {
            try await engine.loadModel(path: modelPath)
            LocalInferenceServer.shared.setEngine(engine)
            modelStates[modelId] = .loaded
        } catch {
            LocalInferenceServer.shared.setEngine(nil)
            modelStates[modelId] = .error("Load failed: \(error.localizedDescription)")
        }
        onStateChanged?()
    }

    func unloadModel() {
        if let id = activeModelId {
            if case .loaded = modelStates[id] {
                modelStates[id] = .downloaded
            }
        }
        activeModelId = nil
        LocalInferenceServer.shared.setEngine(nil)
        onStateChanged?()
    }

    // MARK: - Storage

    func storageUsed() -> Int64 {
        let dir = Self.modelsDirectory()
        guard let enumerator = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let url as URL in enumerator {
            if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                total += Int64(size)
            }
        }
        return total
    }

    func formattedStorageUsed() -> String {
        ByteCountFormatter.string(fromByteCount: storageUsed(), countStyle: .file)
    }

    // MARK: - Helpers

    private func excludeFromBackup(_ url: URL) {
        var url = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }
}

// MARK: - URLSessionDownloadDelegate

extension ModelStore: URLSessionDownloadDelegate {

    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let desc = downloadTask.taskDescription,
              let pipeIndex = desc.firstIndex(of: "|") else { return }

        let modelId = String(desc[desc.startIndex..<pipeIndex])
        let filename = String(desc[desc.index(after: pipeIndex)...])
        let dest = modelDirectory(for: modelId).appendingPathComponent(filename)

        let dir = dest.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: dest)
        try? FileManager.default.moveItem(at: location, to: dest)

        DispatchQueue.main.async {
            self.fileDownloadCompleted(modelId: modelId)
        }
    }

    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let desc = downloadTask.taskDescription,
              let pipeIndex = desc.firstIndex(of: "|") else { return }
        let modelId = String(desc[desc.startIndex..<pipeIndex])

        DispatchQueue.main.async {
            self.updateDownloadProgress(modelId: modelId, bytesWritten: totalBytesWritten, totalExpected: totalBytesExpectedToWrite)
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error = error as? NSError, error.code != NSURLErrorCancelled,
              let desc = task.taskDescription,
              let pipeIndex = desc.firstIndex(of: "|") else { return }
        let modelId = String(desc[desc.startIndex..<pipeIndex])

        DispatchQueue.main.async {
            self.modelStates[modelId] = .error("Download failed: \(error.localizedDescription)")
            self.onStateChanged?()
        }
    }

    private func fileDownloadCompleted(modelId: String) {
        guard var dl = activeDownloads[modelId] else { return }
        dl.completedFiles += 1
        activeDownloads[modelId] = dl

        if dl.completedFiles >= dl.totalFiles {
            activeDownloads.removeValue(forKey: modelId)
            modelStates[modelId] = .downloaded
        }
        onStateChanged?()
    }

    private func updateDownloadProgress(modelId: String, bytesWritten: Int64, totalExpected: Int64) {
        let dl = activeDownloads[modelId]
        let completedFiles = dl?.completedFiles ?? 0
        let totalFiles = max(dl?.totalFiles ?? 1, 1)
        let fileProgress = totalExpected > 0 ? Double(bytesWritten) / Double(totalExpected) : 0
        let overall = (Double(completedFiles) + fileProgress) / Double(totalFiles)
        modelStates[modelId] = .downloading(progress: min(overall, 0.99))
        onStateChanged?()
    }
}
