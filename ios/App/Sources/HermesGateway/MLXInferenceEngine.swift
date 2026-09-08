import Foundation
import MLXLLM
import MLXLMCommon
import Tokenizers

private struct HFTokenizerLoader: TokenizerLoader {
    func load(from directory: URL) async throws -> any MLXLMCommon.Tokenizer {
        let upstream = try await AutoTokenizer.from(modelFolder: directory)
        return TokenizerBridge(upstream)
    }
}

private struct TokenizerBridge: MLXLMCommon.Tokenizer {
    private let upstream: any Tokenizers.Tokenizer

    init(_ upstream: any Tokenizers.Tokenizer) {
        self.upstream = upstream
    }

    func encode(text: String, addSpecialTokens: Bool) -> [Int] {
        upstream.encode(text: text, addSpecialTokens: addSpecialTokens)
    }

    func decode(tokenIds: [Int], skipSpecialTokens: Bool) -> String {
        upstream.decode(tokens: tokenIds, skipSpecialTokens: skipSpecialTokens)
    }

    func convertTokenToId(_ token: String) -> Int? {
        upstream.convertTokenToId(token)
    }

    func convertIdToToken(_ id: Int) -> String? {
        upstream.convertIdToToken(id)
    }

    var bosToken: String? { upstream.bosToken }
    var eosToken: String? { upstream.eosToken }
    var unknownToken: String? { upstream.unknownToken }

    func applyChatTemplate(
        messages: [[String: any Sendable]],
        tools: [[String: any Sendable]]?,
        additionalContext: [String: any Sendable]?
    ) throws -> [Int] {
        let stringMessages: [[String: String]] = messages.map { msg in
            msg.reduce(into: [String: String]()) { result, pair in
                result[pair.key] = "\(pair.value)"
            }
        }
        let anyTools: [[String: Any]]? = tools?.map { tool in
            tool.reduce(into: [String: Any]()) { result, pair in
                result[pair.key] = pair.value
            }
        }
        return try upstream.applyChatTemplate(
            messages: stringMessages,
            chatTemplate: nil,
            addGenerationPrompt: true,
            truncation: false,
            maxLength: nil,
            tools: anyTools
        )
    }
}

final class MLXInferenceEngine: InferenceEngine {

    private var container: ModelContainer?
    private var _loadedModelId: String?
    private var _contextLength: Int = 4096

    var isModelLoaded: Bool { container != nil }
    var loadedModelId: String? { _loadedModelId }
    var contextLength: Int { _contextLength }

    func loadModel(path: URL) async throws {
        unloadModel()

        let newContainer = try await LLMModelFactory.shared.loadContainer(
            from: path,
            using: HFTokenizerLoader()
        )

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

        return AsyncThrowingStream { continuation in
            Task {
                do {
                    let chatMessages: [Chat.Message] = messages.map { msg in
                        let role = Chat.Message.Role(rawValue: msg["role"] as? String ?? "user") ?? .user
                        let content = msg["content"] as? String ?? ""
                        return Chat.Message(role: role, content: content)
                    }

                    let userInput = UserInput(chat: chatMessages, tools: request.tools)

                    let params = GenerateParameters(
                        maxTokens: maxTokens,
                        temperature: Float(temperature)
                    )

                    let lmInput = try await container.prepare(input: userInput)
                    let stream = try await container.generate(
                        input: lmInput,
                        parameters: params
                    )

                    for await event in stream {
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

private func formatToolCall(_ call: ToolCall) -> String {
    let argsData = try? JSONSerialization.data(
        withJSONObject: call.function.arguments.mapValues { $0.anyValue }
    )
    let argsJson = argsData.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    let callId = call.id ?? "call_\(UUID().uuidString.prefix(8))"

    return """
    {"tool_calls":[{"id":"\(callId)","type":"function","function":{"name":"\(call.function.name)","arguments":\(argsJson)}}]}
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
