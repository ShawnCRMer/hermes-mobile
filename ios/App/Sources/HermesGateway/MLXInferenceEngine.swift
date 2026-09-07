import Foundation
import MLXLLM
import MLXLMCommon

/// MLX Swift inference engine — loads safetensors models from mlx-community
/// and generates tokens via Metal on Apple Silicon.
final class MLXInferenceEngine: InferenceEngine {

    private var container: ModelContainer?
    private var _loadedModelId: String?
    private var _contextLength: Int = 4096

    var isModelLoaded: Bool { container != nil }
    var loadedModelId: String? { _loadedModelId }
    var contextLength: Int { _contextLength }

    func loadModel(path: URL) async throws {
        unloadModel()

        let config = ModelConfiguration(directory: path)
        let newContainer = try await LLMModelFactory.shared.loadContainer(
            configuration: config
        ) { progress in
            // Progress is 0..1 for weight loading
            _ = progress.fractionCompleted
        }

        container = newContainer
        _loadedModelId = path.lastPathComponent

        if let modelInfo = ModelStore.catalog.first(where: { $0.id == _loadedModelId }) {
            _contextLength = modelInfo.contextLength
        }
    }

    func unloadModel() {
        container = nil
        _loadedModelId = nil
        _contextLength = 4096
    }

    func generate(request: CompletionRequest) -> AsyncThrowingStream<GeneratedToken, Error> {
        guard let container else {
            return AsyncThrowingStream { $0.finish(throwing: InferenceError.noModelLoaded) }
        }

        let messages = request.messages
        let temperature = request.temperature ?? 0.7
        let maxTokens = request.maxTokens ?? 2048
        let tools = request.tools

        return AsyncThrowingStream { continuation in
            Task {
                do {
                    let chatMessages = messages.map { msg -> [String: String] in
                        [
                            "role": msg["role"] as? String ?? "user",
                            "content": msg["content"] as? String ?? "",
                        ]
                    }

                    let params = GenerateParameters(
                        maxTokens: maxTokens,
                        temperature: Float(temperature)
                    )

                    let input = try await container.createInput(chatMessages)
                    let generated = try container.generate(
                        input: input,
                        parameters: params
                    )

                    for try await event in generated {
                        switch event {
                        case .chunk(let text):
                            continuation.yield(GeneratedToken(text: text, isLast: false))
                        case .info:
                            continuation.yield(GeneratedToken(text: "", isLast: true))
                        case .toolCall(let call):
                            let toolCallJson = formatToolCall(call)
                            continuation.yield(GeneratedToken(text: toolCallJson, isLast: false))
                        }
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }
}

private func formatToolCall(_ call: ToolCallOutput) -> String {
    let argsJson: String
    if let data = try? JSONSerialization.data(withJSONObject: call.arguments),
       let str = String(data: data, encoding: .utf8) {
        argsJson = str
    } else {
        argsJson = "{}"
    }

    return """
    {"tool_calls":[{"id":"call_\(UUID().uuidString.prefix(8))","type":"function","function":{"name":"\(call.name)","arguments":\(argsJson)}}]}
    """
}

enum InferenceError: Error, LocalizedError {
    case noModelLoaded
    case generationFailed(String)

    var errorDescription: String? {
        switch self {
        case .noModelLoaded: return "No model loaded"
        case .generationFailed(let msg): return "Generation failed: \(msg)"
        }
    }
}
