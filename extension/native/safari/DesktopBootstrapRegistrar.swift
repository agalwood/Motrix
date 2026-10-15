import Foundation
import Security
import ServiceManagement
import os

/// Invoked by the desktop shell from Contents/MacOS, never a web message.
@main
enum DesktopBootstrapRegistrar {
    static func verifyCode(at url: URL, requirement: String) throws {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess,
              let code,
              SecStaticCodeCheckValidity(code, [], try BootstrapIPCConfiguration.compileRequirement(requirement)) == errSecSuccess
        else { throw BootstrapIPCError.untrustedProcess }
    }

    static func statusName(_ status: SMAppService.Status) -> String {
        switch status {
        case .notRegistered: "not-registered"
        case .enabled: "enabled"
        case .requiresApproval: "requires-approval"
        case .notFound: "not-found"
        @unknown default: "unknown"
        }
    }

    static func main() {
        let logger = Logger(subsystem: "app.motrix.safari.registration", category: "service-management")
        do {
            guard CommandLine.arguments.count == 2,
                  ["--status", "--register", "--unregister"].contains(CommandLine.arguments[1]),
                  Bundle.main.bundleIdentifier == "app.motrix.native"
            else { throw BootstrapIPCError.invalidRequest }
            let configuration = try signedBootstrapConfiguration()
            let registrarConfiguration = try BootstrapIPCConfiguration(
                teamIdentifier: configuration.teamIdentifier,
                clientBundleIdentifier: configuration.clientBundleIdentifier,
                serviceBundleIdentifier: "app.motrix.safari.registration",
                appGroupIdentifier: configuration.appGroupIdentifier
            )
            try registrarConfiguration.validateCurrentService()
            let bundle = Bundle.main.bundleURL
            try verifyCode(at: bundle, requirement:
                "anchor apple generic and certificate leaf[subject.OU] = \"\(configuration.teamIdentifier)\" and identifier \"app.motrix.native\"")
            try verifyCode(at: bundle.appendingPathComponent("Contents/Library/LaunchServices/MotrixSafariBootstrap"),
                           requirement: configuration.serviceSigningRequirement)
            let plistName = "app.motrix.safari.bootstrap.plist"
            let plist = bundle.appendingPathComponent("Contents/Library/LaunchAgents/\(plistName)")
            guard FileManager.default.fileExists(atPath: plist.path) else { throw BootstrapIPCError.invalidConfiguration }
            let service = SMAppService.agent(plistName: plistName)
            switch CommandLine.arguments[1] {
            case "--register":
                if service.status == .notRegistered || service.status == .notFound { try service.register() }
            case "--unregister":
                if service.status != .notRegistered && service.status != .notFound { try service.unregister() }
            default: break
            }
            let result = try JSONSerialization.data(withJSONObject: ["protocolVersion": 1, "status": statusName(service.status)])
            FileHandle.standardOutput.write(result + Data([10]))
        } catch {
            logger.error("Bootstrap registration command failed: \((error as NSError).code, privacy: .public)")
            FileHandle.standardError.write(Data("bootstrap-registration-failed\n".utf8))
            exit(EXIT_FAILURE)
        }
    }
}
