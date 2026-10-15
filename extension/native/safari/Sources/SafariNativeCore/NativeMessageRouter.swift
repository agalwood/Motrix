import Foundation

/// Routes validated messages without performing discovery or granting access.
public enum NativeMessageRouter {
    public enum Route {
        case response([String: Any])
        case bootstrap(Data)
        case notification(NotificationMessage)
    }

    private static let maximumMessageBytes = 16 * 1024

    private enum Failure: String {
        case malformedMessage = "malformed-message"
        case messageTooLarge = "message-too-large"
        case invalidRequest = "invalid-request"
        case unsupportedAction = "unsupported-action"
        case unsupportedVersion = "unsupported-version"
        case bootstrapUnavailable = "bootstrap-unavailable"

        var response: [String: Any] {
            ["error": rawValue, "protocolVersion": 1]
        }
    }

    public static func handle(message: Any) -> [String: Any] {
        switch route(message: message) {
        case .response(let response):
            return response
        case .bootstrap:
            return Failure.bootstrapUnavailable.response
        case .notification:
            return ["error": "notifications-unavailable", "protocolVersion": 1]
        }
    }

    /// Only a fully validated bootstrap can reach the separately authenticated IPC client.
    public static func route(message: Any) -> Route {
        guard let request = message as? [String: Any],
              JSONSerialization.isValidJSONObject(request),
              let encoded = try? JSONSerialization.data(
                  withJSONObject: request,
                  options: [.withoutEscapingSlashes]
              )
        else {
            return .response(Failure.malformedMessage.response)
        }
        guard encoded.count <= maximumMessageBytes else {
            return .response(Failure.messageTooLarge.response)
        }
        guard let action = request["action"] as? String,
              let version = request["protocolVersion"] as? NSNumber,
              !isBoolean(version)
        else {
            return .response(Failure.invalidRequest.response)
        }
        guard version == NSNumber(value: 1) else {
            return .response(Failure.unsupportedVersion.response)
        }

        switch action {
        case "ping":
            guard Set(request.keys) == ["action", "protocolVersion", "requestId"],
                  let requestID = request["requestId"] as? String,
                  requestID.count == 36,
                  UUID(uuidString: requestID) != nil
            else {
                return .response(Failure.invalidRequest.response)
            }
            return .response([
                "action": "pong",
                "protocolVersion": 1,
                "requestId": requestID,
                "capabilities": ["bootstrap": false],
            ])

        case "bootstrap":
            guard Set(request.keys) == ["action", "protocolVersion", "bindingPub", "allowLaunch"],
                  let bindingPublicKey = request["bindingPub"] as? String,
                  isCanonicalPublicKey(bindingPublicKey),
                  let allowLaunch = request["allowLaunch"] as? NSNumber,
                  isBoolean(allowLaunch)
            else {
                return .response(Failure.invalidRequest.response)
            }
            return .bootstrap(encoded)

        case "notifications.status", "notifications.test", "notifications.send", "notifications.openSettings":
            guard let notification = NotificationMessage(request) else {
                return .response(Failure.invalidRequest.response)
            }
            return .notification(notification)

        default:
            return .response(Failure.unsupportedAction.response)
        }
    }

    private static func isBoolean(_ number: NSNumber) -> Bool {
        CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    private static func isCanonicalPublicKey(_ value: String) -> Bool {
        guard value.utf8.count == 43,
              value.utf8.allSatisfy({ byte in
                  (65...90).contains(byte) || (97...122).contains(byte)
                      || (48...57).contains(byte) || byte == 45 || byte == 95
              })
        else {
            return false
        }
        let padded = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/") + "="
        guard let bytes = Data(base64Encoded: padded), bytes.count == 32 else {
            return false
        }
        let canonical = bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return value == canonical
    }
}
