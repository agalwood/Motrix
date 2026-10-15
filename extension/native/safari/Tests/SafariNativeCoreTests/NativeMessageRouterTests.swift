import Foundation
import XCTest
@testable import SafariNativeCore

final class NativeMessageRouterTests: XCTestCase {
    private let requestID = "4ea61785-6c25-47a7-aa2e-4f08c3ae516b"

    private var ping: [String: Any] {
        ["action": "ping", "protocolVersion": 1, "requestId": requestID]
    }

    private var bootstrap: [String: Any] {
        [
            "action": "bootstrap",
            "protocolVersion": 1,
            "bindingPub": String(repeating: "A", count: 43),
            "allowLaunch": false,
        ]
    }

    private func assertFailure(
        _ message: Any,
        _ code: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let response = NativeMessageRouter.handle(message: message)
        XCTAssertEqual(response["error"] as? String, code, file: file, line: line)
        XCTAssertEqual(response["protocolVersion"] as? Int, 1, file: file, line: line)
        XCTAssertEqual(Set(response.keys), ["error", "protocolVersion"], file: file, line: line)
    }

    func testPingReturnsCorrelatedPongWithoutBootstrapCapability() throws {
        let parsed = try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: ping))
        let response = NativeMessageRouter.handle(message: parsed)
        XCTAssertEqual(response["action"] as? String, "pong")
        XCTAssertEqual(response["protocolVersion"] as? Int, 1)
        XCTAssertEqual(response["requestId"] as? String, requestID)
        XCTAssertEqual((response["capabilities"] as? [String: Bool])?["bootstrap"], false)
        XCTAssertNil(response["error"])
        XCTAssertEqual(Set(response.keys), ["action", "protocolVersion", "requestId", "capabilities"])
    }

    func testRequestIDEchoPreservesCase() {
        var request = ping
        request["requestId"] = requestID.uppercased()
        let response = NativeMessageRouter.handle(message: request)
        XCTAssertEqual(response["requestId"] as? String, requestID.uppercased())
    }

    func testRejectsNonObjectAndNonJSONMessages() {
        let malformed: [Any] = [
            NSNull(), true, 1, "{}", [], [ping],
            ["action": "ping", "date": Date()],
            ["action": "ping", "number": Double.nan],
            ["action": "ping", "number": Double.infinity],
            [1: "value"],
        ]
        for message in malformed {
            assertFailure(message, "malformed-message")
        }
    }

    func testRejectsMissingWronglyTypedAndUnexpectedFields() {
        assertFailure([:], "invalid-request")
        for field in ping.keys {
            var request = ping
            request.removeValue(forKey: field)
            assertFailure(request, "invalid-request")
            request = ping
            request[field] = NSNull()
            assertFailure(request, "invalid-request")
        }
        var extra = ping
        extra["secret"] = "must-not-be-echoed"
        assertFailure(extra, "invalid-request")
        for invalidID: Any in ["", "not-a-uuid", "{\(requestID)}", requestID + " ", 42, true] {
            var request = ping
            request["requestId"] = invalidID
            assertFailure(request, "invalid-request")
        }
    }

    func testRejectsUnknownActionAndVersion() {
        var request = ping
        request["action"] = "start"
        assertFailure(request, "unsupported-action")
        request["action"] = "Ping"
        assertFailure(request, "unsupported-action")
        for version in [0, 2, -1, 1.5] {
            request = ping
            request["protocolVersion"] = version
            assertFailure(request, "unsupported-version")
        }
    }

    func testBooleanIsNotAProtocolNumber() throws {
        for version: Any in [true, false, "1", [1], ["value": 1]] {
            var request = ping
            request["protocolVersion"] = version
            assertFailure(request, "invalid-request")
        }
        let parsed = try JSONSerialization.jsonObject(
            with: Data("{\"action\":\"ping\",\"protocolVersion\":true,\"requestId\":\"\(requestID)\"}".utf8)
        )
        assertFailure(parsed, "invalid-request")
    }

    func testEnforcesCompactJSONByteLimitInclusively() throws {
        var request = ping
        request["requestId"] = ""
        let overhead = try JSONSerialization.data(withJSONObject: request).count
        request["requestId"] = String(repeating: "a", count: 16 * 1024 - overhead)
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: request).count, 16 * 1024)
        assertFailure(request, "invalid-request")
        request["requestId"] = String(repeating: "a", count: 16 * 1024 - overhead + 1)
        assertFailure(request, "message-too-large")
        request["requestId"] = String(repeating: "界", count: 6_000)
        assertFailure(request, "message-too-large")
    }

    func testValidBootstrapNeverGrantsAnEndpointOrTicket() throws {
        for allowLaunch in [false, true] {
            var request = bootstrap
            request["allowLaunch"] = allowLaunch
            assertFailure(request, "bootstrap-unavailable")
            let parsed = try JSONSerialization.jsonObject(
                with: JSONSerialization.data(withJSONObject: request)
            )
            assertFailure(parsed, "bootstrap-unavailable")
        }
    }

    func testBootstrapRequiresExactFieldsAndBooleanLaunchFlag() {
        for field in bootstrap.keys {
            var request = bootstrap
            request.removeValue(forKey: field)
            assertFailure(request, "invalid-request")
        }
        for allowLaunch: Any in [0, 1, "true", NSNull(), [], [:]] {
            var request = bootstrap
            request["allowLaunch"] = allowLaunch
            assertFailure(request, "invalid-request")
        }
        var extra = bootstrap
        extra["origin"] = "safari-web-extension://untrusted"
        assertFailure(extra, "invalid-request")
    }

    func testBootstrapRequiresCanonicalBase64URLForExactly32Bytes() {
        let invalidKeys: [Any] = [
            "", String(repeating: "A", count: 42), String(repeating: "A", count: 44),
            String(repeating: "A", count: 43) + "=",
            String(repeating: "A", count: 42) + "B", // Nonzero unused padding bits.
            "+" + String(repeating: "A", count: 42),
            "/" + String(repeating: "A", count: 42),
            " " + String(repeating: "A", count: 42),
            String(repeating: "A", count: 42) + "\n",
            32, NSNull(), [0, 1],
        ]
        for key in invalidKeys {
            var request = bootstrap
            request["bindingPub"] = key
            assertFailure(request, "invalid-request")
        }
        var request = bootstrap
        request["bindingPub"] = Data(repeating: 255, count: 32).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        assertFailure(request, "bootstrap-unavailable")
    }

    func testOnlyValidatedBootstrapReachesIPCRoute() throws {
        for allowLaunch in [false, true] {
            var request = bootstrap
            request["allowLaunch"] = allowLaunch
            guard case .bootstrap(let data) = NativeMessageRouter.route(message: request) else {
                return XCTFail("A valid bootstrap should reach the IPC boundary")
            }
            let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(decoded["allowLaunch"] as? Bool, allowLaunch)
            XCTAssertEqual(decoded["bindingPub"] as? String, bootstrap["bindingPub"] as? String)
            XCTAssertEqual(Set(decoded.keys), Set(request.keys))
        }
        var extra = bootstrap
        extra["serviceName"] = "untrusted.service"
        var wrongVersion = bootstrap
        wrongVersion["protocolVersion"] = 2
        var badKey = bootstrap
        badKey["bindingPub"] = "invalid"
        for message: Any in [ping, extra, wrongVersion, badKey, NSNull()] {
            guard case .response = NativeMessageRouter.route(message: message) else {
                return XCTFail("Invalid or local-only messages must never reach IPC")
            }
        }
    }
}
