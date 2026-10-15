import Foundation
import UserNotifications
import AppKit

enum NotificationDispatcher {
    static func handle(_ request: NotificationMessage, profile: UUID?) async -> [String: Any] {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        let authorization: String
        switch settings.authorizationStatus {
        case .notDetermined: authorization = "notDetermined"
        case .denied: authorization = "denied"
        case .authorized, .provisional, .ephemeral: authorization = "authorized"
        @unknown default: authorization = "unavailable"
        }
        var result: [String: Any] = [
            "action": request.action.rawValue,
            "protocolVersion": 1,
            "notificationVersion": 1,
            "requestId": request.requestID,
            "authorization": authorization,
        ]
        let store = try? receiptStore()
        // Enable delivery only after the installed, signed P0 path is verified.
        let deliveryEnabled = Bundle.main.object(forInfoDictionaryKey: "MotrixNotificationDelivery") as? String == "direct"
        if deliveryEnabled && store != nil { result["delivery"] = "direct" }
        guard request.action != .status else { return result }
        if request.action == .openSettings {
            result["status"] = await openContainingApp() ? "opened" : "failed"
            return result
        }
        guard let store else {
            result["status"] = "failed"
            result["error"] = "notification-storage-unavailable"
            return result
        }
        guard request.action == .test || deliveryEnabled else {
            result["status"] = "suppressed"
            return result
        }
        guard authorization == "authorized" else {
            result["status"] = "suppressed"
            return result
        }
        let now = Date()
        if let expiry = request.expiresAt, expiry <= now || expiry.timeIntervalSince(now) > 125 {
            result["status"] = "suppressed"
            return result
        }
        let identifier: String
        do {
            switch try store.reserve(profile: profile, eventID: request.eventID, kind: request.kind, now: now) {
            case .reserved(let value): identifier = value
            case .duplicate: result["status"] = "duplicate"; return result
            case .unknown: result["status"] = "unknown"; return result
            case .suppressed: result["status"] = "suppressed"; return result
            case .rateLimited:
                result["status"] = "suppressed"
                result["reason"] = "rateLimited"
                return result
            case .failed: result["status"] = "failed"; return result
            }
        } catch {
            result["status"] = "failed"
            result["error"] = "notification-storage-unavailable"
            return result
        }
        let content = UNMutableNotificationContent()
        content.title = request.title ?? "Motrix Extension"
        content.body = request.body ?? NativeStrings.value("options.notifications.testBody")
        content.userInfo = ["motrixEventId": request.eventID.uuidString.lowercased()]
        content.threadIdentifier = "motrix.\(profile?.uuidString.lowercased() ?? "unscoped")"
        var accepted = false
        do {
            try await center.add(UNNotificationRequest(
                identifier: identifier, content: content, trigger: nil
            ))
            accepted = true
            try store.complete(identifier: identifier, outcome: .accepted)
            result["status"] = "accepted"
        } catch {
            // System submission and the receipt transaction cannot be atomic.
            // An accepted request with a failed receipt write must not be resent.
            try? store.complete(identifier: identifier, outcome: accepted ? .unknown : .failed)
            result["status"] = accepted ? "unknown" : "failed"
            result["error"] = accepted ? "notification-result-unknown" : "notification-delivery-failed"
        }
        return result
    }

    @MainActor private static func openContainingApp() async -> Bool {
        let extensionURL = Bundle.main.bundleURL
        let appURL = extensionURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard extensionURL.pathExtension == "appex", appURL.pathExtension == "app",
              Bundle(url: appURL)?.bundleIdentifier == "app.motrix.safari" else { return false }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        return await withCheckedContinuation { continuation in
            NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { app, error in
                continuation.resume(returning: app != nil && error == nil)
            }
        }
    }

    private static func receiptStore() throws -> NotificationReceiptStore {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "MotrixNotificationGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        else { throw NotificationReceiptStore.StoreError.unavailable }
        let directory = container.appendingPathComponent("Library/Application Support/MotrixNotifications", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return try NotificationReceiptStore(url: directory.appendingPathComponent("receipts-v1.sqlite"))
    }
}
