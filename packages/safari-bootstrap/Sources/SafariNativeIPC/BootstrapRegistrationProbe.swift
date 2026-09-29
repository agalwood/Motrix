import Foundation
import Security

/// A separate, read-only interface: only the signed registrar can ask which code owns registration.
@objc(MotrixSafariRegistrationProbe)
protocol BootstrapRegistrationRemote {
    func identity(reply: @escaping @Sendable (Data) -> Void)
}

struct BootstrapRegistrationIdentity: Codable, Equatable, Sendable {
    let executable: String
    let cdHash: Data

    static func read(code: SecStaticCode) throws -> Self {
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(code, [], &information) == errSecSuccess,
              let data = information as? [String: Any],
              let executable = data[kSecCodeInfoMainExecutable as String] as? URL,
              let hash = data[kSecCodeInfoUnique as String] as? Data
        else { throw BootstrapIPCError.untrustedProcess }
        return Self(executable: executable.resolvingSymlinksInPath().path, cdHash: hash)
    }

    static func current() throws -> Self {
        var code: SecCode?
        var staticCode: SecStaticCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode
        else { throw BootstrapIPCError.untrustedProcess }
        return try read(code: staticCode)
    }

    static func expected(at url: URL) throws -> Self {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code
        else { throw BootstrapIPCError.untrustedProcess }
        return try read(code: code)
    }
}

final class BootstrapRegistrationService: NSObject, NSXPCListenerDelegate, BootstrapRegistrationRemote {
    private let listener: NSXPCListener
    private let payload: Data

    init(configuration: BootstrapIPCConfiguration) throws {
        try configuration.validateCurrentService()
        payload = try JSONEncoder().encode(BootstrapRegistrationIdentity.current())
        let registrar = try BootstrapIPCConfiguration(
            teamIdentifier: configuration.teamIdentifier,
            clientBundleIdentifier: "app.motrix.safari.registration",
            serviceBundleIdentifier: configuration.serviceBundleIdentifier,
            appGroupIdentifier: configuration.appGroupIdentifier
        )
        listener = NSXPCListener(machServiceName: configuration.appGroupIdentifier + ".registration")
        super.init()
        listener.setConnectionCodeSigningRequirement(registrar.clientSigningRequirement)
        listener.delegate = self
    }

    #if DEBUG
    init(testClientRequirement: String, payload: Data) {
        self.payload = payload
        listener = NSXPCListener.anonymous()
        super.init()
        listener.setConnectionCodeSigningRequirement(testClientRequirement)
        listener.delegate = self
    }
    var testEndpoint: NSXPCListenerEndpoint { listener.endpoint }
    #endif

    func activate() { listener.activate() }
    deinit { listener.invalidate() }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard listener === self.listener, connection.effectiveUserIdentifier == geteuid() else { return false }
        connection.exportedInterface = NSXPCInterface(with: BootstrapRegistrationRemote.self)
        connection.exportedObject = self
        connection.resume()
        return true
    }

    func identity(reply: @escaping @Sendable (Data) -> Void) { reply(payload) }
}

/// No request data or credentials are sent. The incoming reply must satisfy the service signature.
final class BootstrapRegistrationProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?
    private var connection: NSXPCConnection?

    func matches(configuration: BootstrapIPCConfiguration, expected: BootstrapRegistrationIdentity) async -> Bool {
        await matches(
            connection: NSXPCConnection(machServiceName: configuration.appGroupIdentifier + ".registration"),
            requirement: configuration.serviceSigningRequirement, expected: expected)
    }

    #if DEBUG
    func testMatches(endpoint: NSXPCListenerEndpoint, requirement: String, expected: BootstrapRegistrationIdentity) async -> Bool {
        await matches(connection: NSXPCConnection(listenerEndpoint: endpoint), requirement: requirement, expected: expected)
    }
    #endif

    private func matches(connection: NSXPCConnection, requirement: String, expected: BootstrapRegistrationIdentity) async -> Bool {
        await withCheckedContinuation { continuation in
            lock.lock()
            self.continuation = continuation
            self.connection = connection
            lock.unlock()
            connection.remoteObjectInterface = NSXPCInterface(with: BootstrapRegistrationRemote.self)
            connection.setCodeSigningRequirement(requirement)
            connection.invalidationHandler = { [weak self] in self?.finish(false) }
            connection.interruptionHandler = { [weak self] in self?.finish(false) }
            connection.resume()
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [self] in finish(false) }
            let proxy = connection.remoteObjectProxyWithErrorHandler { [weak self] _ in self?.finish(false) }
            guard let remote = proxy as? BootstrapRegistrationRemote else { finish(false); return }
            remote.identity { [weak self] data in
                let matches = data.count <= 8192 && (try? JSONDecoder().decode(BootstrapRegistrationIdentity.self, from: data)) == expected
                self?.finish(matches)
            }
        }
    }

    private func finish(_ result: Bool) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        let connection = self.connection
        self.connection = nil
        lock.unlock()
        connection?.invalidationHandler = nil
        connection?.interruptionHandler = nil
        connection?.invalidate()
        continuation?.resume(returning: result)
    }
}
