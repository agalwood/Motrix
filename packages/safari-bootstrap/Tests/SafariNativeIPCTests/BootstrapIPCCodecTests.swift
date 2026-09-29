import Foundation
import XCTest
@testable import SafariNativeIPC

final class BootstrapIPCCodecTests: XCTestCase {
    let key = String(repeating: "A", count: 43)

    var request: [String: Any] {
        ["action": "bootstrap", "protocolVersion": 1, "bindingPub": key, "allowLaunch": false]
    }

    var response: [String: Any] {
        ["action": "requestPair", "protocolVersion": 1, "port": 16800, "nonce": "nonce"]
    }

    func encode(_ object: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed, .withoutEscapingSlashes])
    }

    func testConfigurationDerivesConstrainedServiceAndSigningRequirements() throws {
        let configuration = try BootstrapIPCConfiguration(
            teamIdentifier: "ABCDEFGHIJ", clientBundleIdentifier: "app.motrix.extension",
            serviceBundleIdentifier: "app.motrix.bootstrap", appGroupIdentifier: "ABCDEFGHIJ.app.motrix"
        )
        XCTAssertEqual(configuration.machServiceName, "ABCDEFGHIJ.app.motrix.bootstrap")
        XCTAssertEqual(configuration.clientSigningRequirement,
                       "anchor apple generic and certificate leaf[subject.OU] = \"ABCDEFGHIJ\" and identifier \"app.motrix.extension\" and entitlement[\"com.apple.security.application-groups\"] = \"ABCDEFGHIJ.app.motrix\"")
        XCTAssertEqual(configuration.serviceSigningRequirement,
                       "anchor apple generic and certificate leaf[subject.OU] = \"ABCDEFGHIJ\" and identifier \"app.motrix.bootstrap\" and entitlement[\"com.apple.security.application-groups\"] = \"ABCDEFGHIJ.app.motrix\"")
        XCTAssertThrowsError(try configuration.validateCurrentClient())
        XCTAssertThrowsError(try BootstrapIPCClient(configuration: configuration))
        XCTAssertThrowsError(try BootstrapIPCService(configuration: configuration))
    }

    func testConfigurationRejectsMissingIdentityInjectionAndUnrelatedGroup() {
        let valid = ["ABCDEFGHIJ", "app.motrix.extension", "app.motrix.bootstrap", "ABCDEFGHIJ.app.motrix"]
        for index in valid.indices {
            for invalid in ["", " ", "anything\" or true", "app..motrix", "../app"] {
                var inputs = valid
                inputs[index] = invalid
                XCTAssertThrowsError(try BootstrapIPCConfiguration(
                    teamIdentifier: inputs[0], clientBundleIdentifier: inputs[1],
                    serviceBundleIdentifier: inputs[2], appGroupIdentifier: inputs[3]
                ))
            }
        }
        for group in ["OTHERTEAM1.app.motrix", "group.app.motrix", "ABCDEFGHIJ." + String(repeating: "a", count: 120) + ".x"] {
            XCTAssertThrowsError(try BootstrapIPCConfiguration(
                teamIdentifier: valid[0], clientBundleIdentifier: valid[1],
                serviceBundleIdentifier: valid[2], appGroupIdentifier: group
            ))
        }
        for timeout in [Double.nan, Double.infinity, 0, -1, 21] {
            XCTAssertThrowsError(try BootstrapIPCClient.validateTimeout(timeout))
        }
    }

    func testRequestHasExactFieldsCanonicalPublicKeyAndBooleanFlag() throws {
        let parsed = try BootstrapIPCRequest(data: encode(request))
        XCTAssertEqual(parsed.bindingPublicKey, key)
        XCTAssertFalse(parsed.allowLaunch)
        for field in request.keys {
            var malformed = request
            malformed.removeValue(forKey: field)
            XCTAssertThrowsError(try BootstrapIPCRequest(data: encode(malformed)))
        }
        for (field, values) in [
            ("bindingPub", ["", String(repeating: "A", count: 42) + "B", key + "=", 42] as [Any]),
            ("allowLaunch", [0, 1, "true", NSNull()] as [Any]),
            ("protocolVersion", [true, 0, 2, "1", 1.5] as [Any]),
            ("action", ["start", "ping", NSNull()] as [Any]),
        ] {
            for value in values {
                var malformed = request
                malformed[field] = value
                XCTAssertThrowsError(try BootstrapIPCRequest(data: encode(malformed)))
            }
        }
        var malformed = request
        malformed["callerId"] = "spoofed"
        XCTAssertThrowsError(try BootstrapIPCRequest(data: encode(malformed)))
    }

    func testWireSizeAndJSONShapeAreCheckedBeforeParsing() throws {
        let encoded = try encode(request)
        let exactlyLimit = encoded + Data(repeating: 32, count: 16384 - encoded.count)
        XCTAssertNoThrow(try BootstrapIPCRequest(data: exactlyLimit))
        XCTAssertThrowsError(try BootstrapIPCRequest(data: exactlyLimit + Data([32]))) { error in
            XCTAssertEqual(error as? BootstrapIPCError, .messageTooLarge)
        }
        for data in [Data(), Data("[]".utf8), Data("null".utf8), Data("true".utf8), Data([0xff])] {
            XCTAssertThrowsError(try BootstrapIPCRequest(data: data))
        }
    }

    func testSuccessAndFixedErrorsNeverExposeEndpointFields() throws {
        let request = try BootstrapIPCRequest(data: encode(request))
        XCTAssertNoThrow(try BootstrapIPCCodec.validateResponse(encode(response), for: request))
        var nullNonce = response
        nullNonce["nonce"] = NSNull()
        XCTAssertNoThrow(try BootstrapIPCCodec.validateResponse(encode(nullNonce), for: request))
        XCTAssertNoThrow(try BootstrapIPCCodec.validateResponse(BootstrapIPCCodec.unavailable, for: request))
        for extra in ["token", "generation", "endpoint", "message", "debug"] {
            var malformed = response
            malformed[extra] = "secret"
            XCTAssertThrowsError(try BootstrapIPCCodec.validateResponse(encode(malformed), for: request))
        }
        for error in ["secret error text", "", "unsupported-version"] {
            XCTAssertThrowsError(try BootstrapIPCCodec.validateResponse(
                encode(["error": error, "protocolVersion": 1]), for: request
            ))
        }
        for field in response.keys {
            var malformed = response
            malformed.removeValue(forKey: field)
            XCTAssertThrowsError(try BootstrapIPCCodec.validateResponse(encode(malformed), for: request))
        }
    }

    func testResponseRejectsInvalidPortVersionNonceAndOversize() throws {
        let request = try BootstrapIPCRequest(data: encode(request))
        for (field, values) in [
            ("port", [0, -1, 65536, 1.5, true, "16800"] as [Any]),
            ("protocolVersion", [true, 2, "1"] as [Any]),
            ("nonce", ["", String(repeating: "a", count: 513), "line\nbreak", 12, []] as [Any]),
            ("nmTicket", [NSNull(), "ticket", [], [:]] as [Any]),
        ] {
            for value in values {
                var malformed = response
                malformed[field] = value
                XCTAssertThrowsError(try BootstrapIPCCodec.validateResponse(encode(malformed), for: request))
            }
        }
        XCTAssertThrowsError(try BootstrapIPCCodec.validateResponse(Data(repeating: 32, count: 16385), for: request))
    }

    func testTicketShapePreservesOnlyProtocolFieldsAndRequestBinding() throws {
        let request = try BootstrapIPCRequest(data: encode(request))
        let ticket: [String: Any] = [
            "v": 1, "purpose": "mbp1-attestation", "protocolVersion": 1,
            "serverGeneration": "generation", "browser": "safari", "callerId": "app.motrix.extension",
            "exp": 1800000000, "bindingPub": key, "mac": key,
        ]
        var response = response
        response["nmTicket"] = ticket
        XCTAssertNoThrow(try BootstrapIPCCodec.validateResponse(encode(response), for: request))
        for (field, value): (String, Any) in [
            ("token", "secret"), ("browser", "chrome"), ("purpose", "other"),
            ("bindingPub", String(repeating: "B", count: 43)), ("exp", true), ("mac", "x"),
        ] {
            var malformed = ticket
            malformed[field] = value
            response["nmTicket"] = malformed
            XCTAssertThrowsError(try BootstrapIPCCodec.validateResponse(encode(response), for: request))
        }
    }
}
