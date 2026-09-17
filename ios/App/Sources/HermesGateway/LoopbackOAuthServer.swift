import Foundation
import Network

/// One-shot HTTP server on 127.0.0.1 that bridges OAuth loopback redirects
/// to a custom URL scheme so ASWebAuthenticationSession can intercept them.
final class LoopbackOAuthServer {
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.hermes.oauth-loopback")
    private(set) var port: UInt16 = 0
    private let callbackScheme: String

    init(callbackScheme: String) {
        self.callbackScheme = callbackScheme
    }

    func start(onReady: @escaping (UInt16?) -> Void) {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: .ipv4(.loopback), port: .any
        )

        guard let listener = try? NWListener(using: params) else {
            onReady(nil)
            return
        }
        self.listener = listener

        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                if let port = listener.port?.rawValue {
                    self?.port = port
                    onReady(port)
                } else {
                    onReady(nil)
                }
            case .failed:
                onReady(nil)
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }

        listener.start(queue: queue)
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self,
                  let data,
                  let request = String(data: data, encoding: .utf8) else {
                connection.cancel()
                return
            }

            guard let requestLine = request.split(separator: "\r\n", maxSplits: 1).first,
                  let pathStr = requestLine.split(separator: " ").dropFirst().first,
                  let url = URL(string: "http://127.0.0.1\(pathStr)"),
                  let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
                self.send(connection, status: 400, body: "Bad request")
                return
            }

            guard let code = items.first(where: { $0.name == "code" })?.value else {
                self.send(connection, status: 400, body: "Missing authorization code")
                return
            }

            let state = items.first(where: { $0.name == "state" })?.value

            var components = URLComponents()
            components.scheme = self.callbackScheme
            components.host = "auth"
            components.path = "/callback"
            components.queryItems = [URLQueryItem(name: "code", value: code)]
            if let state {
                components.queryItems?.append(URLQueryItem(name: "state", value: state))
            }

            let redirectUrl = components.url?.absoluteString
                ?? "\(self.callbackScheme)://auth/callback?code=\(code)"

            let response = "HTTP/1.1 302 Found\r\nLocation: \(redirectUrl)\r\nConnection: close\r\n\r\n"
            connection.send(content: response.data(using: .utf8), completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }

    private func send(_ connection: NWConnection, status: Int, body: String) {
        let html = "<html><body>\(body)</body></html>"
        let response = "HTTP/1.1 \(status) Error\r\nContent-Type: text/html\r\nConnection: close\r\nContent-Length: \(html.utf8.count)\r\n\r\n\(html)"
        connection.send(content: response.data(using: .utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
