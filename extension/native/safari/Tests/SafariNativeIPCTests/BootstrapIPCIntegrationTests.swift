import Foundation
import Security
import XCTest
@testable import SafariNativeIPC

/// These use actual NSXPC connections, with both peers constrained to this signed test executable.
final class BootstrapIPCIntegrationTests: XCTestCase, @unchecked Sendable {
    private let request = Data("{\"action\":\"bootstrap\",\"protocolVersion\":1,\"bindingPub\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"allowLaunch\":false}".utf8)
    private let success = Data("{\"action\":\"requestPair\",\"protocolVersion\":1,\"port\":16800,\"nonce\":null}".utf8)

    private func currentRequirement() throws -> String {
        var dynamicCode: SecCode?
        var staticCode: SecStaticCode?
        var requirement: SecRequirement?
        var string: CFString?
        guard SecCodeCopySelf([], &dynamicCode) == errSecSuccess, let dynamicCode,
              SecCodeCopyStaticCode(dynamicCode, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopyDesignatedRequirement(staticCode, [], &requirement) == errSecSuccess, let requirement,
              SecRequirementCopyString(requirement, [], &string) == errSecSuccess, let string
        else { throw BootstrapIPCError.untrustedProcess }
        XCTAssertEqual(SecCodeCheckValidity(dynamicCode, [], requirement), errSecSuccess)
        return string as String
    }

    private func client(_ service: BootstrapIPCService, requirement: String, timeout: TimeInterval = 1) throws -> BootstrapIPCClient {
        try BootstrapIPCClient(testEndpoint: service.testEndpoint, serviceRequirement: requirement, timeout: timeout)
    }

    private func assertConnectionsReleased(_ service: BootstrapIPCService) async throws {
        for _ in 0..<50 {
            if service.testActiveConnectionCount == 0 { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(service.testActiveConnectionCount, 0)
    }

    func testActualXPCRoundTripUsesBothSigningRequirementsAndReleasesConnection() async throws {
        let requirement = try currentRequirement()
        let expected = success
        let service = try BootstrapIPCService(testClientRequirement: requirement) { request in
            XCTAssertFalse(request.allowLaunch)
            XCTAssertEqual(request.bindingPublicKey, String(repeating: "A", count: 43))
            return expected
        }
        service.activate()
        defer { service.invalidate() }
        let response = try await client(service, requirement: requirement).bootstrap(request)
        XCTAssertEqual(response, expected)
        try await assertConnectionsReleased(service)
    }

    func testDefaultResolverIsUnavailableOverActualXPC() async throws {
        let requirement = try currentRequirement()
        let service = try BootstrapIPCService(testClientRequirement: requirement)
        service.activate()
        defer { service.invalidate() }
        let response = try await client(service, requirement: requirement).bootstrap(request)
        XCTAssertEqual(response, BootstrapIPCCodec.unavailable)
        try await assertConnectionsReleased(service)
    }

    func testListenerRejectsWrongClientSigningRequirement() async throws {
        let requirement = try currentRequirement()
        let service = try BootstrapIPCService(testClientRequirement: "(\(requirement)) and identifier \"wrong.peer\"") { _ in
            XCTFail("An untrusted caller reached the resolver")
            return BootstrapIPCCodec.unavailable
        }
        service.activate()
        defer { service.invalidate() }
        do {
            _ = try await client(service, requirement: requirement).bootstrap(request)
            XCTFail("Wrong client signature was accepted")
        } catch { XCTAssertEqual(error as? BootstrapIPCError, .unavailable) }
        XCTAssertEqual(service.testActiveConnectionCount, 0)
    }

    func testClientRejectsWrongServiceSigningRequirement() async throws {
        let requirement = try currentRequirement()
        let service = try BootstrapIPCService(testClientRequirement: requirement) { _ in
            XCTFail("A request was delivered to a service with the wrong signature")
            return BootstrapIPCCodec.unavailable
        }
        service.activate()
        defer { service.invalidate() }
        do {
            _ = try await client(service, requirement: "(\(requirement)) and identifier \"wrong.peer\"").bootstrap(request)
            XCTFail("Wrong service signature was accepted")
        } catch { XCTAssertEqual(error as? BootstrapIPCError, .unavailable) }
        try await assertConnectionsReleased(service)
    }

    func testListenerRejectsDifferentEffectiveUser() async throws {
        let requirement = try currentRequirement()
        let service = try BootstrapIPCService(testClientRequirement: requirement, expectedUserID: geteuid() + 1)
        service.activate()
        defer { service.invalidate() }
        do {
            _ = try await client(service, requirement: requirement).bootstrap(request)
            XCTFail("Wrong user was accepted")
        } catch { XCTAssertEqual(error as? BootstrapIPCError, .unavailable) }
        XCTAssertEqual(service.testActiveConnectionCount, 0)
    }

    func testBothPeersRejectMissingRequiredAppGroupBeforeBootstrapDelivery() async throws {
        let requirement = try currentRequirement()
        let missingGroup = "(\(requirement)) and entitlement[\"com.apple.security.application-groups\"] = \"TESTONLY00.app.motrix.missing\""
        for rejectClient in [true, false] {
            let service = try BootstrapIPCService(testClientRequirement: rejectClient ? missingGroup : requirement) { _ in
                XCTFail("A peer without the required App Group reached bootstrap")
                return BootstrapIPCCodec.unavailable
            }
            service.activate()
            defer { service.invalidate() }
            do {
                _ = try await client(service, requirement: rejectClient ? requirement : missingGroup).bootstrap(request)
                XCTFail("A peer without the required App Group was accepted")
            } catch { XCTAssertEqual(error as? BootstrapIPCError, .unavailable) }
            try await assertConnectionsReleased(service)
        }
    }

    func testInvalidResolverResponseIsReplacedWithoutLeakingSecrets() async throws {
        let requirement = try currentRequirement()
        let service = try BootstrapIPCService(testClientRequirement: requirement) { _ in
            Data("{\"token\":\"secret\",\"generation\":\"secret\"}".utf8)
        }
        service.activate()
        defer { service.invalidate() }
        let response = try await client(service, requirement: requirement).bootstrap(request)
        XCTAssertEqual(response, BootstrapIPCCodec.invalidResponse)
        try await assertConnectionsReleased(service)
    }

    func testClientTimeoutCancelsAndReleasesConnection() async throws {
        let requirement = try currentRequirement()
        let service = try BootstrapIPCService(testClientRequirement: requirement) { _ in
            try await Task.sleep(for: .seconds(5))
            return BootstrapIPCCodec.unavailable
        }
        service.activate()
        defer { service.invalidate() }
        do {
            _ = try await client(service, requirement: requirement, timeout: 0.05).bootstrap(request)
            XCTFail("A stalled resolver escaped the client timeout")
        } catch { XCTAssertEqual(error as? BootstrapIPCError, .timedOut) }
        try await assertConnectionsReleased(service)
    }

    func testServiceTimeoutRepliesOnceAndCancelsResolver() async throws {
        let requirement = try currentRequirement()
        let service = try BootstrapIPCService(testClientRequirement: requirement, timeout: 0.03) { _ in
            try await Task.sleep(for: .seconds(5))
            return BootstrapIPCCodec.unavailable
        }
        service.activate()
        defer { service.invalidate() }
        let response = try await client(service, requirement: requirement).bootstrap(request)
        XCTAssertEqual(response, BootstrapIPCCodec.timeout)
        try await assertConnectionsReleased(service)
    }

    func testCancellationAndServiceInvalidationSettleOutstandingCalls() async throws {
        let requirement = try currentRequirement()
        let service = try BootstrapIPCService(testClientRequirement: requirement) { _ in
            try await Task.sleep(for: .seconds(5))
            return BootstrapIPCCodec.unavailable
        }
        service.activate()
        defer { service.invalidate() }
        let client = try client(service, requirement: requirement)
        let request = request
        let cancelled = Task { try await client.bootstrap(request) }
        cancelled.cancel()
        do {
            _ = try await cancelled.value
            XCTFail("Cancelled operation succeeded")
        } catch { XCTAssertEqual(error as? BootstrapIPCError, .cancelled) }
        let disconnected = Task { try await client.bootstrap(request) }
        try await Task.sleep(for: .milliseconds(30))
        service.invalidate()
        do {
            _ = try await disconnected.value
            XCTFail("Invalidated connection succeeded")
        } catch { XCTAssertEqual(error as? BootstrapIPCError, .unavailable) }
        try await assertConnectionsReleased(service)
    }

    func testReplyTimeoutRacesDoNotDoubleResumeAndReleaseEveryConnection() async throws {
        let requirement = try currentRequirement()
        let expected = success
        let service = try BootstrapIPCService(testClientRequirement: requirement, timeout: 0.02) { _ in
            try await Task.sleep(for: .milliseconds(20))
            return expected
        }
        service.activate()
        defer { service.invalidate() }
        let client = try client(service, requirement: requirement, timeout: 0.02)
        for _ in 0..<20 {
            do {
                let response = try await client.bootstrap(request)
                XCTAssertTrue(response == expected || response == BootstrapIPCCodec.timeout)
            } catch { XCTAssertEqual(error as? BootstrapIPCError, .timedOut) }
        }
        try await assertConnectionsReleased(service)
    }
}
