import UIKit
import Social
import UniformTypeIdentifiers

class ShareViewController: SLComposeServiceViewController {

    private let appGroupId = "group.com.mobilehermes.app"
    private let urlScheme = "hermes"

    override func isContentValid() -> Bool {
        return true
    }

    override func didSelectPost() {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else {
            extensionContext?.completeRequest(returningItems: nil)
            return
        }

        let group = DispatchGroup()
        var sharedTexts: [String] = []
        var sharedURLs: [String] = []
        var sharedImagePaths: [String] = []

        for item in items {
            guard let attachments = item.attachments else { continue }

            for provider in attachments {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier) { data, _ in
                        if let url = data as? URL {
                            sharedURLs.append(url.absoluteString)
                        }
                        group.leave()
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { data, _ in
                        if let text = data as? String {
                            sharedTexts.append(text)
                        }
                        group.leave()
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.image.identifier) { data, _ in
                        defer { group.leave() }
                        var imageData: Data?
                        if let url = data as? URL {
                            imageData = try? Data(contentsOf: url)
                        } else if let image = data as? UIImage {
                            imageData = image.jpegData(compressionQuality: 0.85)
                        }
                        guard let bytes = imageData else { return }
                        guard let containerURL = FileManager.default.containerURL(
                            forSecurityApplicationGroupIdentifier: self.appGroupId
                        ) else { return }
                        let filename = "shared-image-\(Int(Date().timeIntervalSince1970 * 1000)).jpg"
                        let fileURL = containerURL.appendingPathComponent(filename)
                        try? bytes.write(to: fileURL)
                        sharedImagePaths.append(filename)
                    }
                }
            }
        }

        group.notify(queue: .main) { [weak self] in
            self?.saveAndOpenApp(texts: sharedTexts, urls: sharedURLs, images: sharedImagePaths)
        }
    }

    private func saveAndOpenApp(texts: [String], urls: [String], images: [String]) {
        guard let defaults = UserDefaults(suiteName: appGroupId) else {
            extensionContext?.completeRequest(returningItems: nil)
            return
        }

        let payload: [String: Any] = [
            "texts": texts,
            "urls": urls,
            "images": images,
            "userText": contentText ?? "",
            "timestamp": Date().timeIntervalSince1970
        ]
        defaults.set(payload, forKey: "pendingShare")
        defaults.synchronize()

        let url = URL(string: "\(urlScheme)://share/incoming")!
        var responder: UIResponder? = self
        while let r = responder {
            if let application = r as? UIApplication {
                application.open(url)
                break
            }
            if r.responds(to: NSSelectorFromString("openURL:")) {
                r.perform(NSSelectorFromString("openURL:"), with: url)
                break
            }
            responder = r.next
        }

        extensionContext?.completeRequest(returningItems: nil)
    }

    override func configurationItems() -> [Any]! {
        return []
    }
}
