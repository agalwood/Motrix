import Foundation
import Security

public enum BootstrapIPCError: Error, Sendable, Equatable {
    case invalidConfiguration
    case untrustedProcess
    case invalidRequest
    case messageTooLarge
    case invalidResponse
    case unavailable
    case timedOut
    case cancelled
}

/// Production identity is explicit; there is no unsigned or bundle-ID-only mode.
public struct BootstrapIPCConfiguration: Sendable {
    public let teamIdentifier: String
    public let clientBundleIdentifier: String
    public let serviceBundleIdentifier: String
    public let appGroupIdentifier: String
    public let machServiceName: String
    public let clientSigningRequirement: String
    public let serviceSigningRequirement: String

    public init(
        teamIdentifier: String,
        clientBundleIdentifier: String,
        serviceBundleIdentifier: String,
        appGroupIdentifier: String
    ) throws {
        guard teamIdentifier.utf8.count == 10,
              teamIdentifier.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) }),
              Self.isBundleIdentifier(clientBundleIdentifier),
              Self.isBundleIdentifier(serviceBundleIdentifier),
              appGroupIdentifier.hasPrefix(teamIdentifier + "."),
              Self.isBundleIdentifier(String(appGroupIdentifier.dropFirst(11))),
              (appGroupIdentifier + ".bootstrap").utf8.count <= 127
        else { throw BootstrapIPCError.invalidConfiguration }

        let clientRequirement = Self.requirement(team: teamIdentifier, identifier: clientBundleIdentifier, group: appGroupIdentifier)
        let serviceRequirement = Self.requirement(team: teamIdentifier, identifier: serviceBundleIdentifier, group: appGroupIdentifier)
        _ = try Self.compileRequirement(clientRequirement)
        _ = try Self.compileRequirement(serviceRequirement)
        self.teamIdentifier = teamIdentifier
        self.clientBundleIdentifier = clientBundleIdentifier
        self.serviceBundleIdentifier = serviceBundleIdentifier
        self.appGroupIdentifier = appGroupIdentifier
        machServiceName = appGroupIdentifier + ".bootstrap"
        clientSigningRequirement = clientRequirement
        serviceSigningRequirement = serviceRequirement
    }

    /// Checks the running process, never a mutable executable path supplied by a caller.
    public func validateCurrentClient() throws {
        try validateCurrentProcess(requirement: clientSigningRequirement)
    }

    public func validateCurrentService() throws {
        try validateCurrentProcess(requirement: serviceSigningRequirement)
    }

    private func validateCurrentProcess(requirement: String) throws {
        var currentCode: SecCode?
        guard SecCodeCopySelf([], &currentCode) == errSecSuccess,
              let currentCode,
              SecCodeCheckValidity(currentCode, [], try Self.compileRequirement(requirement)) == errSecSuccess,
              let task = SecTaskCreateFromSelf(nil),
              let groups = SecTaskCopyValueForEntitlement(
                  task, "com.apple.security.application-groups" as CFString, nil
              ) as? [String], groups.contains(appGroupIdentifier)
        else { throw BootstrapIPCError.untrustedProcess }
    }

    static func compileRequirement(_ string: String) throws -> SecRequirement {
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(string as CFString, [], &requirement) == errSecSuccess,
              let requirement
        else { throw BootstrapIPCError.invalidConfiguration }
        return requirement
    }

    private static func requirement(team: String, identifier: String, group: String) -> String {
        "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\" and identifier \"\(identifier)\""
            + " and entitlement[\"com.apple.security.application-groups\"] = \"\(group)\""
    }

    private static func isBundleIdentifier(_ value: String) -> Bool {
        guard value.utf8.count <= 255 else { return false }
        let components = value.split(separator: ".", omittingEmptySubsequences: false)
        return components.count >= 2 && components.allSatisfy { component in
            guard let first = component.utf8.first,
                  isAlphaNumeric(first), let last = component.utf8.last, isAlphaNumeric(last)
            else { return false }
            return component.utf8.allSatisfy { isAlphaNumeric($0) || $0 == 45 }
        }
    }

    private static func isAlphaNumeric(_ byte: UInt8) -> Bool {
        (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
    }
}
