import Foundation

/// Keep this interface small: Foundation permits only the declared Data values on the wire.
@objc(MotrixSafariBootstrapIPC)
protocol BootstrapIPCRemote {
    func authenticate(reply: @escaping @Sendable () -> Void)
    func bootstrap(_ request: Data, reply: @escaping @Sendable (Data) -> Void)
}

public struct BootstrapIPCClient: Sendable {
    private let makeConnection: @Sendable () -> NSXPCConnection
    private let serviceRequirement: String
    private let timeout: TimeInterval

    public init(configuration: BootstrapIPCConfiguration, timeout: TimeInterval = 18) throws {
        try Self.validateTimeout(timeout)
        try configuration.validateCurrentClient()
        let serviceName = configuration.machServiceName
        makeConnection = { NSXPCConnection(machServiceName: serviceName) }
        serviceRequirement = configuration.serviceSigningRequirement
        self.timeout = timeout
    }

    /// Every call uses a fresh connection and invalidates it on every terminal path.
    public func bootstrap(_ data: Data) async throws -> Data {
        let request = try BootstrapIPCRequest(data: data)
        let operation = BootstrapIPCOperation(
            connection: makeConnection(), requirement: serviceRequirement,
            requestData: data, request: request, timeout: timeout
        )
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { operation.start($0) }
        } onCancel: {
            operation.cancel()
        }
    }

    static func validateTimeout(_ timeout: TimeInterval) throws {
        guard timeout.isFinite, timeout > 0, timeout <= 20 else {
            throw BootstrapIPCError.invalidConfiguration
        }
    }

    #if DEBUG
    /// Available only to @testable clients of debug builds, never a production configuration switch.
    init(testEndpoint: NSXPCListenerEndpoint, serviceRequirement: String, timeout: TimeInterval) throws {
        try Self.validateTimeout(timeout)
        _ = try BootstrapIPCConfiguration.compileRequirement(serviceRequirement)
        let endpoint = TestEndpoint(value: testEndpoint)
        makeConnection = { NSXPCConnection(listenerEndpoint: endpoint.value) }
        self.serviceRequirement = serviceRequirement
        self.timeout = timeout
    }

    private struct TestEndpoint: @unchecked Sendable {
        let value: NSXPCListenerEndpoint
    }
    #endif
}

/// All completion paths share one serial queue, including cancellation before start.
private final class BootstrapIPCOperation: @unchecked Sendable {
    private let queue = DispatchQueue(label: "app.motrix.safari.bootstrap-request")
    private var connection: NSXPCConnection?
    private var proxy: (any BootstrapIPCRemote)?
    private let requirement: String
    private let requestData: Data
    private let request: BootstrapIPCRequest
    private let timeout: TimeInterval
    private var continuation: CheckedContinuation<Data, any Error>?
    private var result: Result<Data, BootstrapIPCError>?
    private var timer: DispatchSourceTimer?
    private var sentBootstrap = false

    init(connection: NSXPCConnection, requirement: String, requestData: Data,
         request: BootstrapIPCRequest, timeout: TimeInterval) {
        self.connection = connection
        self.requirement = requirement
        self.requestData = requestData
        self.request = request
        self.timeout = timeout
    }

    func start(_ continuation: CheckedContinuation<Data, any Error>) {
        queue.async { [self] in
            if let result {
                continuation.resume(with: result.mapError { $0 as any Error })
                return
            }
            self.continuation = continuation
            guard let connection else {
                finish(.failure(.unavailable))
                return
            }
            connection.remoteObjectInterface = NSXPCInterface(with: BootstrapIPCRemote.self)
            connection.setCodeSigningRequirement(requirement)
            connection.interruptionHandler = { [weak self] in self?.complete(.failure(.unavailable)) }
            connection.invalidationHandler = { [weak self] in self?.complete(.failure(.unavailable)) }
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + timeout)
            timer.setEventHandler { [weak self] in self?.finish(.failure(.timedOut)) }
            self.timer = timer
            timer.resume()
            connection.resume()
            guard let proxy = connection.remoteObjectProxyWithErrorHandler({ [weak self] _ in
                self?.complete(.failure(.unavailable))
            }) as? BootstrapIPCRemote else {
                finish(.failure(.unavailable))
                return
            }
            self.proxy = proxy
            // Foundation checks incoming messages, not the first outgoing request.
            // Authenticate an empty reply before sending even a public binding key.
            proxy.authenticate { [weak self] in self?.authenticated() }
        }
    }

    private func authenticated() {
        queue.async { [self] in
            guard result == nil, !sentBootstrap, let proxy else { return }
            sentBootstrap = true
            proxy.bootstrap(requestData) { [weak self] response in
                guard let self else { return }
                do {
                    try BootstrapIPCCodec.validateResponse(response, for: request)
                    complete(.success(response))
                } catch {
                    complete(.failure(.invalidResponse))
                }
            }
        }
    }

    func cancel() { complete(.failure(.cancelled)) }

    private func complete(_ result: Result<Data, BootstrapIPCError>) {
        queue.async { [self] in finish(result) }
    }

    private func finish(_ result: Result<Data, BootstrapIPCError>) {
        guard self.result == nil else { return }
        self.result = result
        timer?.setEventHandler {}
        timer?.cancel()
        timer = nil
        proxy = nil
        connection?.interruptionHandler = nil
        connection?.invalidationHandler = nil
        connection?.invalidate()
        connection = nil
        let continuation = self.continuation
        self.continuation = nil
        continuation?.resume(with: result.mapError { $0 as any Error })
    }
}
