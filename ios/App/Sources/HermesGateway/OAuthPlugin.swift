import Capacitor
import AuthenticationServices

@objc(OAuthPlugin)
class OAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "OAuthPlugin"
    let jsName = "OAuth"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise)
    ]

    private var authSession: ASWebAuthenticationSession?
    private var loopbackServer: LoopbackOAuthServer?

    @objc func authenticate(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let components = URLComponents(string: urlString) else {
            call.reject("Missing or invalid url")
            return
        }

        let callbackScheme = call.getString("callbackScheme") ?? "hermes"

        let server = LoopbackOAuthServer(callbackScheme: callbackScheme)
        self.loopbackServer = server

        server.start { [weak self] port in
            guard let self, let port else {
                call.reject("Failed to start loopback server")
                return
            }

            var mutable = components
            var items = mutable.queryItems ?? []
            items.removeAll { $0.name == "redirect_uri" }
            items.append(URLQueryItem(
                name: "redirect_uri",
                value: "http://127.0.0.1:\(port)/oauth-callback"
            ))
            mutable.queryItems = items

            guard let authURL = mutable.url else {
                call.reject("Failed to build authorize URL")
                self.cleanup()
                return
            }

            DispatchQueue.main.async {
                self.startSession(url: authURL, callbackScheme: callbackScheme, call: call)
            }
        }
    }

    private func startSession(url: URL, callbackScheme: String, call: CAPPluginCall) {
        let session = ASWebAuthenticationSession(
            url: url,
            callbackURLScheme: callbackScheme
        ) { [weak self] callbackURL, error in
            self?.cleanup()

            if let asError = error as? ASWebAuthenticationSessionError,
               asError.code == .canceledLogin {
                call.resolve(["cancelled": true])
                return
            }
            if let error {
                call.reject(error.localizedDescription)
                return
            }
            guard let callbackURL else {
                call.reject("No callback URL received")
                return
            }
            call.resolve(["url": callbackURL.absoluteString, "cancelled": false])
        }

        session.prefersEphemeralWebBrowserSession = false
        session.presentationContextProvider = self
        self.authSession = session

        if !session.start() {
            call.reject("Failed to start authentication session")
            cleanup()
        }
    }

    private func cleanup() {
        loopbackServer?.stop()
        loopbackServer = nil
        authSession = nil
    }
}

extension OAuthPlugin: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(
        for session: ASWebAuthenticationSession
    ) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
