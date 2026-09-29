import Foundation

/// Implemented by the signed native host. No resolver, launch behavior, or endpoint access is implicit.
public typealias BootstrapIPCResolver = @Sendable (BootstrapIPCRequest) async throws -> Data

public final class BootstrapIPCService: NSObject, NSXPCListenerDelegate, @unchecked Sendable {
    private let listener: NSXPCListener
    private let resolver: BootstrapIPCResolver
    private let timeout: TimeInterval
    private let expectedUserID: uid_t
    private let lock = NSLock()
    private var connections: [UUID: NSXPCConnection] = [:]
    private var stopped = false

    public init(
        configuration: BootstrapIPCConfiguration,
        timeout: TimeInterval = 18,
        resolver: BootstrapIPCResolver? = nil
    ) throws {
        try BootstrapIPCClient.validateTimeout(timeout)
        try configuration.validateCurrentService()
        listener = NSXPCListener(machServiceName: configuration.machServiceName)
        self.resolver = resolver ?? { _ in BootstrapIPCCodec.unavailable }
        self.timeout = timeout
        expectedUserID = geteuid()
        super.init()
        listener.setConnectionCodeSigningRequirement(configuration.clientSigningRequirement)
        listener.delegate = self
    }

    public func activate() {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return }
        listener.activate()
    }

    /// Call when the native host exits; outstanding clients receive invalidation.
    public func invalidate() {
        lock.lock()
        stopped = true
        let active = Array(connections.values)
        connections.removeAll()
        lock.unlock()
        listener.invalidate()
        active.forEach { $0.invalidate() }
    }

    deinit { invalidate() }

    public func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard listener === self.listener, connection.effectiveUserIdentifier == expectedUserID else { return false }
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return false }
        let id = UUID()
        let session = BootstrapIPCSession(resolver: resolver, timeout: timeout)
        connection.exportedInterface = NSXPCInterface(with: BootstrapIPCRemote.self)
        connection.exportedObject = session
        connection.invalidationHandler = { [weak self, session] in
            session.cancel()
            self?.removeConnection(id)
        }
        connection.interruptionHandler = { [weak connection, session] in
            session.cancel()
            connection?.invalidate()
        }
        connections[id] = connection
        connection.resume()
        return true
    }

    private func removeConnection(_ id: UUID) {
        lock.lock()
        connections.removeValue(forKey: id)
        lock.unlock()
    }

    #if DEBUG
    init(testClientRequirement: String, expectedUserID: uid_t = geteuid(), timeout: TimeInterval = 1,
         resolver: @escaping BootstrapIPCResolver = { _ in BootstrapIPCCodec.unavailable }) throws {
        try BootstrapIPCClient.validateTimeout(timeout)
        _ = try BootstrapIPCConfiguration.compileRequirement(testClientRequirement)
        listener = NSXPCListener.anonymous()
        self.resolver = resolver
        self.timeout = timeout
        self.expectedUserID = expectedUserID
        super.init()
        listener.setConnectionCodeSigningRequirement(testClientRequirement)
        listener.delegate = self
    }

    var testEndpoint: NSXPCListenerEndpoint { listener.endpoint }

    var testActiveConnectionCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return connections.count
    }
    #endif
}

/// A connection is deliberately single-use, matching the bootstrap handoff lifecycle.
private final class BootstrapIPCSession: NSObject, BootstrapIPCRemote, @unchecked Sendable {
    private let resolver: BootstrapIPCResolver
    private let timeout: TimeInterval
    private let queue = DispatchQueue(label: "app.motrix.safari.bootstrap-session")
    private var used = false
    private var completed = false
    private var reply: (@Sendable (Data) -> Void)?
    private var task: Task<Void, Never>?
    private var timer: DispatchSourceTimer?

    init(resolver: @escaping BootstrapIPCResolver, timeout: TimeInterval) {
        self.resolver = resolver
        self.timeout = timeout
    }

    func authenticate(reply: @escaping @Sendable () -> Void) {
        reply()
    }

    func bootstrap(_ data: Data, reply: @escaping @Sendable (Data) -> Void) {
        queue.async { [self] in
            guard !used, !completed else {
                reply(BootstrapIPCCodec.invalidRequest)
                return
            }
            used = true
            self.reply = reply
            let request: BootstrapIPCRequest
            do { request = try BootstrapIPCRequest(data: data) }
            catch {
                finish(BootstrapIPCCodec.invalidRequest)
                return
            }
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + timeout)
            timer.setEventHandler { [weak self] in self?.finish(BootstrapIPCCodec.timeout) }
            self.timer = timer
            timer.resume()
            task = Task { [weak self, resolver] in
                let response: Data
                do {
                    let result = try await resolver(request)
                    do {
                        try BootstrapIPCCodec.validateResponse(result, for: request)
                        response = result
                    } catch { response = BootstrapIPCCodec.invalidResponse }
                } catch { response = BootstrapIPCCodec.unavailable }
                self?.complete(response)
            }
        }
    }

    func cancel() { complete(nil) }

    private func complete(_ response: Data?) {
        queue.async { [self] in finish(response) }
    }

    private func finish(_ response: Data?) {
        guard !completed else { return }
        completed = true
        timer?.setEventHandler {}
        timer?.cancel()
        timer = nil
        task?.cancel()
        task = nil
        let reply = self.reply
        self.reply = nil
        if let response { reply?(response) }
    }
}
