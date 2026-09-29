import Foundation
import XCTest
@testable import SafariNativeIPC

private actor ResolverFixture {
    var probes = 0
    var launches = 0
    let availableAfter: Int
    let launchFails: Bool
    let ready = Data("{\"action\":\"requestPair\",\"protocolVersion\":1,\"port\":16800,\"nonce\":null}".utf8)

    init(availableAfter: Int, launchFails: Bool = false) {
        self.availableAfter = availableAfter
        self.launchFails = launchFails
    }

    func probe() -> Data {
        probes += 1
        return probes > availableAfter ? ready : BootstrapIPCCodec.unavailable
    }

    func launch() throws {
        launches += 1
        if launchFails { throw BootstrapIPCError.untrustedProcess }
    }
}

final class BootstrapDesktopResolverTests: XCTestCase, @unchecked Sendable {
    func testLaunchPathIsTheContainingDesktopOnly() throws {
        let path = "/tmp/Motrix.app/Contents/Library/LaunchServices/MotrixSafariBootstrap"
        let actual = try BootstrapDesktopLauncher.containingDesktop(executable: URL(fileURLWithPath: path))
        XCTAssertEqual(actual.path, URL(fileURLWithPath: "/tmp/Motrix.app").resolvingSymlinksInPath().path)
        for invalid in [
            "/tmp/Motrix.app/Contents/MacOS/MotrixSafariBootstrap",
            "/tmp/Motrix.app/Contents/Library/LaunchServices/OtherService",
            "/tmp/Motrix/Contents/Library/LaunchServices/MotrixSafariBootstrap",
        ] {
            XCTAssertThrowsError(try BootstrapDesktopLauncher.containingDesktop(executable: URL(fileURLWithPath: invalid)))
        }
    }

    func testPassiveProbeNeverLaunchesOrPolls() async throws {
        let fixture = ResolverFixture(availableAfter: 3)
        let result = try await BootstrapDesktopResolver().resolve(allowLaunch: false) {
            await fixture.probe()
        } launch: { try await fixture.launch() }
        XCTAssertEqual(result, BootstrapIPCCodec.unavailable)
        let counts = await (fixture.probes, fixture.launches)
        XCTAssertEqual(counts.0, 1)
        XCTAssertEqual(counts.1, 0)
    }

    func testRunningDesktopDoesNotLaunchAgain() async throws {
        let fixture = ResolverFixture(availableAfter: 0)
        let result = try await BootstrapDesktopResolver().resolve(allowLaunch: true) {
            await fixture.probe()
        } launch: { try await fixture.launch() }
        XCTAssertEqual(result, fixture.ready)
        let launches = await fixture.launches
        XCTAssertEqual(launches, 0)
    }

    func testExplicitWakeLaunchesOnceAndReturnsFreshHandoff() async throws {
        let fixture = ResolverFixture(availableAfter: 2)
        let resolver = BootstrapDesktopResolver(timeout: .seconds(1), interval: .milliseconds(1))
        let result = try await resolver.resolve(allowLaunch: true) {
            await fixture.probe()
        } launch: { try await fixture.launch() }
        XCTAssertEqual(result, fixture.ready)
        let counts = await (fixture.probes, fixture.launches)
        XCTAssertEqual(counts.0, 3)
        XCTAssertEqual(counts.1, 1)
    }

    func testRejectedHostFailsClosedWithoutPolling() async throws {
        let fixture = ResolverFixture(availableAfter: 2, launchFails: true)
        let result = try await BootstrapDesktopResolver().resolve(allowLaunch: true) {
            await fixture.probe()
        } launch: { try await fixture.launch() }
        let error = try BootstrapIPCCodec.object(result, response: true)["error"] as? String
        XCTAssertEqual(error, "launch-denied")
        let probes = await fixture.probes
        XCTAssertEqual(probes, 1)
    }

    func testDeadlineStopsPolling() async throws {
        let fixture = ResolverFixture(availableAfter: .max)
        let result = try await BootstrapDesktopResolver(timeout: .milliseconds(5), interval: .milliseconds(1))
            .resolve(allowLaunch: true) { await fixture.probe() } launch: { try await fixture.launch() }
        XCTAssertEqual(result, BootstrapIPCCodec.unavailable)
        let launches = await fixture.launches
        XCTAssertEqual(launches, 1)
    }

    func testMalformedDiscoveryNeverTriggersLaunch() async throws {
        let fixture = ResolverFixture(availableAfter: 0)
        let malformed = Data("{\"error\":\"bootstrap-unavailable\",\"protocolVersion\":true}".utf8)
        let result = try await BootstrapDesktopResolver().resolve(allowLaunch: true) {
            malformed
        } launch: { try await fixture.launch() }
        XCTAssertEqual(result, malformed)
        let launches = await fixture.launches
        XCTAssertEqual(launches, 0)
    }
}
