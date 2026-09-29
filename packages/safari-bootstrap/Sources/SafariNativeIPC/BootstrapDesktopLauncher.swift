import AppKit
import Foundation
import Security

/// Launch only the verified desktop bundle containing this running service.
enum BootstrapDesktopLauncher {
    static func containingDesktop(executable: URL) throws -> URL {
        let service = executable.resolvingSymlinksInPath()
        let services = service.deletingLastPathComponent()
        let library = services.deletingLastPathComponent()
        let contents = library.deletingLastPathComponent()
        let app = contents.deletingLastPathComponent()
        guard service.lastPathComponent == "MotrixSafariBootstrap",
              services.lastPathComponent == "LaunchServices",
              library.lastPathComponent == "Library",
              contents.lastPathComponent == "Contents",
              app.pathExtension == "app"
        else { throw BootstrapIPCError.untrustedProcess }
        return app
    }

    @MainActor
    static func launch(configuration: BootstrapIPCConfiguration) async throws {
        try Task.checkCancellation()
        try configuration.validateCurrentService()
        var current: SecCode?
        var currentStatic: SecStaticCode?
        var information: CFDictionary?
        guard SecCodeCopySelf([], &current) == errSecSuccess, let current,
              SecCodeCopyStaticCode(current, [], &currentStatic) == errSecSuccess, let currentStatic,
              SecCodeCopySigningInformation(currentStatic, [], &information) == errSecSuccess,
              let dictionary = information as? [String: Any],
              let executable = dictionary[kSecCodeInfoMainExecutable as String] as? URL
        else { throw BootstrapIPCError.untrustedProcess }
        let app = try containingDesktop(executable: executable)
        let requirement = try BootstrapIPCConfiguration.compileRequirement(
            "anchor apple generic and certificate leaf[subject.OU] = \"\(configuration.teamIdentifier)\" and identifier \"app.motrix.native\""
        )
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess,
              let code, SecStaticCodeCheckValidity(code, [], requirement) == errSecSuccess
        else { throw BootstrapIPCError.untrustedProcess }
        try Task.checkCancellation()
        let options = NSWorkspace.OpenConfiguration()
        options.activates = false
        _ = try await NSWorkspace.shared.openApplication(at: app, configuration: options)
    }
}

/// Keep the native Rust resolver discovery-only; the signed host owns wake-up.
actor BootstrapDesktopResolver {
    private var busy = false
    private let timeout: Duration
    private let interval: Duration

    init(timeout: Duration = .seconds(10), interval: Duration = .milliseconds(250)) {
        self.timeout = timeout
        self.interval = interval
    }

    func resolve(
        allowLaunch: Bool,
        probe: @Sendable () async throws -> Data,
        launch: @Sendable () async throws -> Void
    ) async throws -> Data {
        guard !busy else { return BootstrapIPCCodec.unavailable }
        try Task.checkCancellation()
        busy = true
        defer { busy = false }
        let result = try await probe()
        guard allowLaunch, Self.isUnavailable(result) else { return result }
        try Task.checkCancellation()
        do { try await launch() }
        catch is CancellationError { throw CancellationError() }
        catch { return Data("{\"error\":\"launch-denied\",\"protocolVersion\":1}".utf8) }
        let deadline = ContinuousClock.now.advanced(by: timeout)
        repeat {
            try Task.checkCancellation()
            let response = try await probe()
            if !Self.isUnavailable(response) { return response }
            try await Task.sleep(for: interval)
        } while ContinuousClock.now < deadline
        return BootstrapIPCCodec.unavailable
    }

    private static func isUnavailable(_ data: Data) -> Bool {
        guard let object = try? BootstrapIPCCodec.object(data, response: true) else { return false }
        return Set(object.keys) == ["error", "protocolVersion"]
            && BootstrapIPCCodec.integer(object["protocolVersion"], in: 1...1)
            && object["error"] as? String == "bootstrap-unavailable"
    }
}
