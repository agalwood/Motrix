import SafariServices
import os

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let logger = Logger(subsystem: "app.motrix.safari.extension", category: "messaging")

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] ?? NSNull()
        switch NativeMessageRouter.route(message: message) {
        case .response(let result):
            complete(context, result: result)
        case .notification(let request):
            let profile: UUID?
            if #available(macOS 14.0, *) {
                profile = item?.userInfo?[SFExtensionProfileKey] as? UUID
            } else { profile = nil }
            Task {
                complete(context, result: await NotificationDispatcher.handle(request, profile: profile))
            }
        case .bootstrap(let request):
            // Configuration comes only from the signed extension bundle, never JavaScript.
            // Only signed bootstrap builds embed this configuration.
            guard let settings = Bundle.main.object(forInfoDictionaryKey: "MotrixBootstrapIPC") as? [String: String],
                  Set(settings.keys) == ["TeamIdentifier", "ClientBundleIdentifier", "ServiceBundleIdentifier", "AppGroupIdentifier"],
                  let team = settings["TeamIdentifier"],
                  let clientID = settings["ClientBundleIdentifier"],
                  let serviceID = settings["ServiceBundleIdentifier"],
                  let group = settings["AppGroupIdentifier"],
                  let configuration = try? BootstrapIPCConfiguration(
                      teamIdentifier: team, clientBundleIdentifier: clientID,
                      serviceBundleIdentifier: serviceID, appGroupIdentifier: group
                  ),
                  let client = try? BootstrapIPCClient(configuration: configuration)
            else {
                complete(context, result: failure("bootstrap-unavailable"))
                return
            }
            Task {
                do {
                    let data = try await client.bootstrap(request)
                    guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        complete(context, result: failure("invalid-response"))
                        return
                    }
                    complete(context, result: result)
                } catch let error as BootstrapIPCError {
                    let code: String
                    switch error {
                    case .timedOut: code = "bootstrap-timeout"
                    case .cancelled: code = "bootstrap-cancelled"
                    case .invalidResponse: code = "invalid-response"
                    default: code = "bootstrap-unavailable"
                    }
                    complete(context, result: failure(code))
                } catch {
                    complete(context, result: failure("bootstrap-unavailable"))
                }
            }
        }
    }

    private func failure(_ code: String) -> [String: Any] {
        ["error": code, "protocolVersion": 1]
    }

    private func complete(_ context: NSExtensionContext, result: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: result]
        // Log the outcome only; never log arbitrary messages or pairing material.
        let outcome = result["action"] as? String ?? result["error"] as? String ?? "invalid"
        logger.notice("Native message result: \(outcome, privacy: .public)")
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
