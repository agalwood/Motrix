import Foundation
import XCTest
@testable import SafariNativeIPC

final class BootstrapRegistrationTests: XCTestCase {
    @MainActor
    func testMatchingOwnerDoesNotInterruptColdLaunch() async throws {
        var mutations = 0
        let result = try await BootstrapRegistrationReconciler.reconcile(
            status: { "enabled" }, matches: { true },
            unregister: { mutations += 1 }, register: { mutations += 1 })
        XCTAssertEqual(result, "enabled")
        XCTAssertEqual(mutations, 0)
    }

    @MainActor
    func testStaleOwnerRebindsAndVerifiesBeforeReportingEnabled() async throws {
        var state = "enabled"
        var registrations = 0
        var removals = 0
        let result = try await BootstrapRegistrationReconciler.reconcile(
            status: { state }, matches: { registrations == 2 },
            unregister: { removals += 1; state = "not-registered" },
            register: { registrations += 1; state = "enabled" })
        XCTAssertEqual(result, "enabled")
        XCTAssertEqual(registrations, 2)
        XCTAssertEqual(removals, 2)
    }

    @MainActor
    func testUserDisabledServiceIsNeverReenabled() async throws {
        var mutations = 0
        let result = try await BootstrapRegistrationReconciler.reconcile(
            status: { "requires-approval" }, matches: { XCTFail("must not probe"); return false },
            unregister: { mutations += 1 }, register: { mutations += 1 })
        XCTAssertEqual(result, "requires-approval")
        XCTAssertEqual(mutations, 0)
    }

    @MainActor
    func testFailedOwnerVerificationIsBounded() async throws {
        var registrations = 0
        let result = try await BootstrapRegistrationReconciler.reconcile(
            status: { "enabled" }, matches: { false }, unregister: {},
            register: { registrations += 1 })
        XCTAssertEqual(result, "failed")
        XCTAssertEqual(registrations, 2)
    }

    @MainActor
    func testApprovalRequiredAfterRegistrationStopsRepair() async throws {
        var state = "not-registered"
        let result = try await BootstrapRegistrationReconciler.reconcile(
            status: { state }, matches: { XCTFail("must not probe disabled service"); return false },
            unregister: { XCTFail("not registered") }, register: { state = "requires-approval" })
        XCTAssertEqual(result, "requires-approval")
    }

    func testIdentityIncludesBothCanonicalExecutableAndCodeHash() {
        let identity = BootstrapRegistrationIdentity(executable: "/Applications/Motrix.app/helper", cdHash: Data([1]))
        XCTAssertNotEqual(identity, BootstrapRegistrationIdentity(executable: "/tmp/Motrix.app/helper", cdHash: Data([1])))
        XCTAssertNotEqual(identity, BootstrapRegistrationIdentity(executable: identity.executable, cdHash: Data([2])))
    }
}
