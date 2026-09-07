import Foundation
import Hummingbird
import NIOCore
import NIOPosix

/// OpenAI-compatible HTTP server on loopback for on-device inference.
///
/// Exposes:
/// - POST /v1/chat/completions  (streaming SSE + non-streaming)
/// - GET  /v1/models
/// - GET  /props                (llama-server fingerprint for Hermes auto-detect)
/// - GET  /health
///
/// Uses Hummingbird 2 — same stack as SharpAI/SwiftLM.
final class LocalInferenceServer: Sendable {

    static let shared = LocalInferenceServer()

    private let _port = ManagedAtomic<UInt16>(0)
    private let _running = ManagedAtomic<Bool>(false)
    private let engineHolder = EngineHolder()

    var port: UInt16 { _port.load(ordering: .relaxed) }
    var isRunning: Bool { _running.load(ordering: .relaxed) }

    var onStatusChanged: (@Sendable (Bool, UInt16) -> Void)?

    private var serverTask: Task<Void, Never>?
    private let thermalThrottle = ThermalThrottle()

    private init() {}

    // MARK: - Start / Stop

    func start(preferredPort: UInt16 = 8080) {
        guard !isRunning else { return }

        let router = buildRouter()
        let app = Application(
            router: router,
            configuration: .init(
                address: .hostname("127.0.0.1", port: Int(preferredPort)),
                serverName: "hermes-mobile-local"
            )
        )

        serverTask = Task {
            do {
                try await app.run()
            } catch {
                self._running.store(false, ordering: .relaxed)
                self._port.store(0, ordering: .relaxed)
            }
        }

        // Poll for the server to be ready (Hummingbird starts async)
        Task {
            for _ in 0..<50 {
                try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
                if let boundPort = try? await self.probePort(preferredPort) {
                    self._port.store(UInt16(boundPort), ordering: .relaxed)
                    self._running.store(true, ordering: .relaxed)
                    self.onStatusChanged?(true, UInt16(boundPort))
                    return
                }
            }
        }
    }

    func stop() {
        serverTask?.cancel()
        serverTask = nil
        _running.store(false, ordering: .relaxed)
        _port.store(0, ordering: .relaxed)
        onStatusChanged?(false, 0)
    }

    func setEngine(_ engine: (any InferenceEngine)?) {
        engineHolder.engine = engine
    }

    private func probePort(_ port: UInt16) async throws -> Int? {
        let url = URL(string: "http://127.0.0.1:\(port)/health")!
        let (_, response) = try await URLSession.shared.data(from: url)
        if let http = response as? HTTPURLResponse, http.statusCode == 200 {
            return Int(port)
        }
        return nil
    }

    // MARK: - Router

    private func buildRouter() -> Router<BasicRequestContext> {
        let router = Router()
        let holder = engineHolder

        router.get("/health") { _, _ in
            Response(
                status: .ok,
                headers: [.contentType: "application/json"],
                body: .init(byteBuffer: ByteBuffer(string: #"{"status":"ok"}"#))
            )
        }

        router.get("/props") { _, _ in
            let modelId = holder.engine?.loadedModelId ?? "none"
            let ctx = holder.engine?.contextLength ?? 4096
            let json = """
            {"build_info":"hermes-mobile-local","model_path":"\(modelId)","total_slots":1,"default_generation_settings":{"n_ctx":\(ctx),"model":"\(modelId)"}}
            """
            return Response(
                status: .ok,
                headers: [.contentType: "application/json"],
                body: .init(byteBuffer: ByteBuffer(string: json))
            )
        }

        router.get("/v1/models") { _, _ in
            let modelId = holder.engine?.loadedModelId ?? "none"
            let json = """
            {"object":"list","data":[{"id":"\(modelId)","object":"model","owned_by":"local"}]}
            """
            return Response(
                status: .ok,
                headers: [.contentType: "application/json"],
                body: .init(byteBuffer: ByteBuffer(string: json))
            )
        }

        router.post("/v1/chat/completions") { request, context in
            let body = try await request.body.collect(upTo: 1_048_576)
            guard let json = try? JSONSerialization.jsonObject(with: Data(buffer: body)) as? [String: Any],
                  let messages = json["messages"] as? [[String: Any]] else {
                return Response(
                    status: .badRequest,
                    headers: [.contentType: "application/json"],
                    body: .init(byteBuffer: ByteBuffer(string: #"{"error":{"message":"missing messages","type":"invalid_request_error"}}"#))
                )
            }

            guard let engine = holder.engine, engine.isModelLoaded else {
                return Response(
                    status: .serviceUnavailable,
                    headers: [.contentType: "application/json"],
                    body: .init(byteBuffer: ByteBuffer(string: #"{"error":{"message":"no model loaded","type":"server_error"}}"#))
                )
            }

            let stream = (json["stream"] as? Bool) ?? false
            let completionRequest = CompletionRequest(
                model: (json["model"] as? String) ?? "default",
                messages: messages,
                stream: stream,
                temperature: json["temperature"] as? Double,
                maxTokens: json["max_tokens"] as? Int,
                tools: json["tools"] as? [[String: Any]],
                stop: json["stop"] as? [String]
            )

            let throttledRequest = CompletionRequest(
                model: completionRequest.model,
                messages: completionRequest.messages,
                stream: completionRequest.stream,
                temperature: completionRequest.temperature,
                maxTokens: self.thermalThrottle.throttledMaxTokens(completionRequest.maxTokens),
                tools: completionRequest.tools,
                stop: completionRequest.stop
            )

            if stream {
                return Self.streamResponse(engine: engine, request: throttledRequest)
            } else {
                return try await Self.nonStreamResponse(engine: engine, request: throttledRequest)
            }
        }

        return router
    }

    // MARK: - Streaming

    private static func streamResponse(engine: any InferenceEngine, request: CompletionRequest) -> Response {
        let id = "chatcmpl-\(UUID().uuidString.prefix(8))"
        let model = request.model

        let stream = AsyncStream<ByteBuffer> { continuation in
            Task {
                do {
                    for try await token in engine.generate(request: request) {
                        let delta: String
                        if token.text.isEmpty {
                            delta = #"{"role":"assistant"}"#
                        } else {
                            let escaped = token.text
                                .replacingOccurrences(of: "\\", with: "\\\\")
                                .replacingOccurrences(of: "\"", with: "\\\"")
                                .replacingOccurrences(of: "\n", with: "\\n")
                                .replacingOccurrences(of: "\r", with: "\\r")
                                .replacingOccurrences(of: "\t", with: "\\t")
                            delta = #"{"role":"assistant","content":"\#(escaped)"}"#
                        }
                        let finish = token.isLast ? #""stop""# : "null"
                        let chunk = #"data: {"id":"\#(id)","object":"chat.completion.chunk","created":\#(Int(Date().timeIntervalSince1970)),"model":"\#(model)","choices":[{"index":0,"delta":\#(delta),"finish_reason":\#(finish)}]}"# + "\n\n"
                        continuation.yield(ByteBuffer(string: chunk))
                    }
                    continuation.yield(ByteBuffer(string: "data: [DONE]\n\n"))
                } catch {
                    let errMsg = error.localizedDescription
                        .replacingOccurrences(of: "\"", with: "'")
                    continuation.yield(ByteBuffer(string: #"data: {"error":{"message":"\#(errMsg)"}}"# + "\n\n"))
                }
                continuation.finish()
            }
        }

        return Response(
            status: .ok,
            headers: [
                .contentType: "text/event-stream",
                .init("Cache-Control")!: "no-cache",
                .init("Connection")!: "keep-alive",
                .init("Access-Control-Allow-Origin")!: "*",
            ],
            body: .init(asyncSequence: stream)
        )
    }

    private static func nonStreamResponse(engine: any InferenceEngine, request: CompletionRequest) async throws -> Response {
        var fullText = ""
        var tokenCount = 0
        for try await token in engine.generate(request: request) {
            fullText += token.text
            tokenCount += 1
        }

        let escaped = fullText
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\t", with: "\\t")

        let json = """
        {"id":"chatcmpl-\(UUID().uuidString.prefix(8))","object":"chat.completion","created":\(Int(Date().timeIntervalSince1970)),"model":"\(request.model)","choices":[{"index":0,"message":{"role":"assistant","content":"\(escaped)"},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":\(tokenCount),"total_tokens":\(tokenCount)}}
        """

        return Response(
            status: .ok,
            headers: [.contentType: "application/json"],
            body: .init(byteBuffer: ByteBuffer(string: json))
        )
    }
}

// MARK: - Thread-safe engine holder

final class EngineHolder: Sendable {
    nonisolated(unsafe) var engine: (any InferenceEngine)?
}

// MARK: - Request / token types

struct CompletionRequest: Sendable {
    let model: String
    nonisolated(unsafe) let messages: [[String: Any]]
    let stream: Bool
    let temperature: Double?
    let maxTokens: Int?
    nonisolated(unsafe) let tools: [[String: Any]]?
    let stop: [String]?
}

struct GeneratedToken: Sendable {
    let text: String
    let isLast: Bool
}

// MARK: - Inference engine protocol

protocol InferenceEngine: Sendable {
    func generate(request: CompletionRequest) -> AsyncThrowingStream<GeneratedToken, Error>
    func loadModel(path: URL) async throws
    func unloadModel()
    var isModelLoaded: Bool { get }
    var loadedModelId: String? { get }
    var contextLength: Int { get }
}

// MARK: - Thermal throttle

final class ThermalThrottle: Sendable {
    func throttledMaxTokens(_ requested: Int?) -> Int {
        let base = requested ?? 2048
        let state = ProcessInfo.processInfo.thermalState
        switch state {
        case .serious:
            return min(base, 512)
        case .critical:
            return min(base, 256)
        default:
            return base
        }
    }

    var shouldRefuseGeneration: Bool {
        ProcessInfo.processInfo.thermalState == .critical
    }
}

// MARK: - Atomic helper

final class ManagedAtomic<T>: Sendable where T: Sendable {
    private let lock = NSLock()
    private var value: T

    init(_ initial: T) { self.value = initial }

    func load(ordering: Void = ()) -> T {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func store(_ newValue: T, ordering: Void = ()) {
        lock.lock()
        defer { lock.unlock() }
        value = newValue
    }
}
