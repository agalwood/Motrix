import Foundation

/// Notification messages are independent of desktop bootstrap availability.
public struct NotificationMessage: Sendable {
    public enum Action: String, Sendable {
        case status = "notifications.status"
        case test = "notifications.test"
        case send = "notifications.send"
        case openSettings = "notifications.openSettings"
    }

    public let action: Action
    public let requestID: String
    public let eventID: UUID
    public let kind: String
    public let title: String?
    public let body: String?
    public let expiresAt: Date?

    public init?(_ value: [String: Any]) {
        guard let action = (value["action"] as? String).flatMap(Action.init(rawValue:)),
              let version = value["notificationVersion"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version == NSNumber(value: 1),
              let requestID = value["requestId"] as? String,
              requestID.count == 36, UUID(uuidString: requestID) != nil
        else { return nil }
        self.action = action
        self.requestID = requestID
        let base: Set<String> = ["action", "protocolVersion", "notificationVersion", "requestId"]
        if action == .send {
            guard Set(value.keys) == base.union(["eventId", "kind", "title", "body", "expiresAt"]),
                  let event = value["eventId"] as? String, event.count == 36, let eventID = UUID(uuidString: event),
                  let kind = value["kind"] as? String,
                  ["task.completed", "task.failed", "task.summary", "pairing.revoked", "connection.reminder", "download.feedback"].contains(kind),
                  let title = value["title"] as? String, Self.validText(title, maximum: 120),
                  let body = value["body"] as? String, Self.validText(body, maximum: 300),
                  let expiry = value["expiresAt"] as? NSNumber, CFGetTypeID(expiry) != CFBooleanGetTypeID(),
                  expiry.doubleValue.isFinite, expiry.doubleValue > 0
            else { return nil }
            self.eventID = eventID
            self.kind = kind
            self.title = title
            self.body = body
            self.expiresAt = Date(timeIntervalSince1970: expiry.doubleValue / 1000)
        } else {
            guard Set(value.keys) == base, let eventID = UUID(uuidString: requestID) else { return nil }
            self.eventID = eventID
            self.kind = "test"
            self.title = nil
            self.body = nil
            self.expiresAt = nil
        }
    }

    private static func validText(_ text: String, maximum: Int) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && text.unicodeScalars.count <= maximum
            && text.unicodeScalars.allSatisfy { scalar in
                scalar.value >= 32 && !(127...159).contains(scalar.value)
                    && !(0x202a...0x202e).contains(scalar.value)
                    && !(0x2066...0x2069).contains(scalar.value)
            }
    }
}
