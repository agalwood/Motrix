import Foundation
import XCTest
@testable import SafariNativeCore

final class NotificationReceiptStoreTests: XCTestCase {
    private var directory: URL!
    private var databaseURL: URL { directory.appendingPathComponent("receipts.sqlite") }
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directory)
    }

    func testAcceptedDeliveryRemainsDuplicateAfterReopening() throws {
        let profile = UUID(), event = UUID()
        do {
            let store = try NotificationReceiptStore(url: databaseURL)
            guard case .reserved(let identifier) = try store.reserve(profile: profile, eventID: event, kind: "task.completed", now: now) else {
                return XCTFail("Expected delivery claim")
            }
            try store.complete(identifier: identifier, outcome: .accepted)
        }
        let reopened = try NotificationReceiptStore(url: databaseURL)
        XCTAssertEqual(try reopened.reserve(profile: profile, eventID: event, kind: "task.completed", now: now.addingTimeInterval(1)), .duplicate)
    }

    func testTwoConnectionsCannotBothClaimAnEvent() throws {
        let first = try NotificationReceiptStore(url: databaseURL)
        let second = try NotificationReceiptStore(url: databaseURL)
        let profile = UUID(), event = UUID()
        guard case .reserved(let identifier) = try first.reserve(profile: profile, eventID: event, kind: "task.failed", now: now) else {
            return XCTFail("Expected first claim")
        }
        XCTAssertEqual(try second.reserve(profile: profile, eventID: event, kind: "task.failed", now: now), .unknown)
        try first.complete(identifier: identifier, outcome: .accepted)
        XCTAssertEqual(try second.reserve(profile: profile, eventID: event, kind: "task.failed", now: now), .duplicate)
    }

    func testCrashBeforeReceiptCompletionDoesNotBlindlyResend() throws {
        let event = UUID()
        do {
            let store = try NotificationReceiptStore(url: databaseURL)
            _ = try store.reserve(profile: nil, eventID: event, kind: "task.completed", now: now)
        }
        let reopened = try NotificationReceiptStore(url: databaseURL)
        XCTAssertEqual(try reopened.reserve(profile: nil, eventID: event, kind: "task.completed", now: now.addingTimeInterval(600)), .unknown)
    }

    func testSameEventInDifferentProfilesGetsSeparateClaims() throws {
        let store = try NotificationReceiptStore(url: databaseURL)
        let event = UUID()
        var identifiers = Set<String>()
        for profile: UUID? in [UUID(), UUID(), nil] {
            guard case .reserved(let identifier) = try store.reserve(profile: profile, eventID: event, kind: "task.completed", now: now) else {
                return XCTFail("Profile collision")
            }
            identifiers.insert(identifier)
        }
        XCTAssertEqual(identifiers.count, 3)
    }

    func testRateLimitsSurviveAnotherStoreInstanceAndRecoverAfterWindow() throws {
        let profile = UUID()
        let store = try NotificationReceiptStore(url: databaseURL, perProfileLimit: 2)
        for _ in 0..<2 { _ = try store.reserve(profile: profile, eventID: UUID(), kind: "task.completed", now: now) }
        let another = try NotificationReceiptStore(url: databaseURL, perProfileLimit: 2)
        XCTAssertEqual(try another.reserve(profile: profile, eventID: UUID(), kind: "task.completed", now: now), .rateLimited)
        guard case .reserved = try another.reserve(profile: profile, eventID: UUID(), kind: "task.completed", now: now.addingTimeInterval(61)) else {
            return XCTFail("Rate window did not expire")
        }
    }

    func testInstallationLimitAppliesAcrossProfiles() throws {
        let store = try NotificationReceiptStore(url: databaseURL, installationLimit: 2)
        for _ in 0..<2 { _ = try store.reserve(profile: UUID(), eventID: UUID(), kind: "task.completed", now: now) }
        XCTAssertEqual(try store.reserve(profile: UUID(), eventID: UUID(), kind: "task.completed", now: now), .rateLimited)
    }

    func testRateLimitedIdentityIsNotClaimedAndCanBeReservedAfterTheWindow() throws {
        let store = try NotificationReceiptStore(url: databaseURL, perProfileLimit: 1)
        let profile = UUID(), event = UUID()
        _ = try store.reserve(profile: profile, eventID: UUID(), kind: "task.completed", now: now)
        XCTAssertEqual(try store.reserve(profile: profile, eventID: event, kind: "task.summary", now: now), .rateLimited)
        guard case .reserved = try store.reserve(profile: profile, eventID: event, kind: "task.summary", now: now.addingTimeInterval(61)) else {
            return XCTFail("Throttling must not reserve delivery or overwrite its identity")
        }
    }

    func testCapacityDoesNotEvictReceiptsAndRetentionEventuallyReleasesSpace() throws {
        let store = try NotificationReceiptStore(url: databaseURL, capacity: 1)
        let event = UUID()
        guard case .reserved(let identifier) = try store.reserve(profile: nil, eventID: event, kind: "task.completed", now: now) else {
            return XCTFail("Expected claim")
        }
        try store.complete(identifier: identifier, outcome: .accepted)
        XCTAssertEqual(try store.reserve(profile: nil, eventID: UUID(), kind: "task.completed", now: now.addingTimeInterval(120)), .suppressed)
        XCTAssertEqual(try store.reserve(profile: nil, eventID: event, kind: "task.completed", now: now.addingTimeInterval(120)), .duplicate)
        guard case .reserved = try store.reserve(profile: nil, eventID: UUID(), kind: "task.completed", now: now.addingTimeInterval(7 * 24 * 60 * 60 + 1)) else {
            return XCTFail("Expired receipt retained")
        }
    }

    func testTestNotificationHasIndependentCooldownAndCannotOverwriteAnOutcome() throws {
        let store = try NotificationReceiptStore(url: databaseURL)
        guard case .reserved(let identifier) = try store.reserve(profile: nil, eventID: UUID(), kind: "test", now: now) else {
            return XCTFail("Expected claim")
        }
        try store.complete(identifier: identifier, outcome: .failed)
        XCTAssertThrowsError(try store.complete(identifier: identifier, outcome: .accepted))
        XCTAssertEqual(try store.reserve(profile: nil, eventID: UUID(), kind: "test", now: now.addingTimeInterval(9)), .rateLimited)
        guard case .reserved = try store.reserve(profile: nil, eventID: UUID(), kind: "test", now: now.addingTimeInterval(11)) else {
            return XCTFail("Test cooldown did not expire")
        }
    }
}
