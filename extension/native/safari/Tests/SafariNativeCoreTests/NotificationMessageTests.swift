import Foundation
import XCTest
@testable import SafariNativeCore

final class NotificationMessageTests: XCTestCase {
    private var request: [String: Any] {
        ["action": "notifications.status", "protocolVersion": 1, "notificationVersion": 1,
         "requestId": "4ea61785-6c25-47a7-aa2e-4f08c3ae516b"]
    }

    func testNotificationRouteDoesNotUseDesktopBootstrap() {
        for action in ["notifications.status", "notifications.test", "notifications.openSettings"] {
            var input = request
            input["action"] = action
            guard case .notification(let message) = NativeMessageRouter.route(message: input) else {
                XCTFail("Expected notification route")
                continue
            }
            XCTAssertEqual(message.action.rawValue, action)
            XCTAssertEqual(message.requestID, input["requestId"] as? String)
        }
    }

    func testSettingsLaunchAcceptsNoCallerURLOrArguments() {
        for (key, value): (String, Any) in [("url", "file:///tmp/other.app"), ("arguments", ["--run"]), ("bundleIdentifier", "other.app")] {
            var input = request
            input["action"] = "notifications.openSettings"
            input[key] = value
            XCTAssertEqual(NativeMessageRouter.handle(message: input)["error"] as? String, "invalid-request")
        }
    }

    func testRejectsUnknownFieldsInvalidVersionAndUncorrelatedMessages() {
        for (key, value): (String, Any) in [
            ("notificationVersion", true), ("notificationVersion", 2),
            ("notificationVersion", "1"), ("requestId", "invalid"),
            ("url", "file:///private/example"), ("profile", UUID().uuidString),
        ] {
            var input = request
            input[key] = value
            let result = NativeMessageRouter.handle(message: input)
            XCTAssertEqual(result["error"] as? String, "invalid-request")
        }
    }

    private var send: [String: Any] {
        var value = request
        value["action"] = "notifications.send"
        value["eventId"] = UUID().uuidString
        value["kind"] = "task.completed"
        value["title"] = "Download complete"
        value["body"] = "example.zip"
        value["expiresAt"] = Date().addingTimeInterval(120).timeIntervalSince1970 * 1000
        return value
    }

    func testSendAcceptsBoundedDisplayTextAndAStableEventIdentity() {
        var input = send
        input["body"] = "ملف 👩‍💻.zip"
        guard case .notification(let message) = NativeMessageRouter.route(message: input) else {
            return XCTFail("Expected send route")
        }
        XCTAssertEqual(message.action, .send)
        XCTAssertEqual(message.body, input["body"] as? String)
        XCTAssertEqual(message.eventID.uuidString, input["eventId"] as? String)
    }

    func testBusinessKindsAreIndependentOfPreferenceCategories() {
        for kind in ["task.completed", "task.failed", "task.summary", "pairing.revoked", "connection.reminder", "download.feedback"] {
            var input = send
            input["kind"] = kind
            XCTAssertEqual(NotificationMessage(input)?.kind, kind)
        }
        for kind in ["confirm", "error", "reminder", "test", "task.execute"] {
            var input = send
            input["kind"] = kind
            XCTAssertNil(NotificationMessage(input))
        }
    }

    func testSendRejectsControlCharactersOversizedContentAndInjectedRouting() {
        for (key, value): (String, Any) in [
            ("title", ""), ("body", "  "), ("title", String(repeating: "x", count: 121)),
            ("body", String(repeating: "😀", count: 301)), ("body", "secret\npath"),
            ("body", "\u{202e}file.exe"), ("kind", "execute"), ("eventId", "not-a-uuid"),
            ("expiresAt", true), ("expiresAt", "1790000000000"),
            ("profile", UUID().uuidString), ("url", "https://example.com/"),
        ] {
            var input = send
            input[key] = value
            XCTAssertEqual(NativeMessageRouter.handle(message: input)["error"] as? String, "invalid-request")
        }
    }
}
