import Foundation
import os

/// The C ABI is linked statically; no subprocess, argv identity, or dynamic library is accepted.
private actor NativeBootstrapResolver {
    private let queue = DispatchQueue(label: "app.motrix.safari.rust-bootstrap")

    func resolve(_ request: BootstrapIPCRequest) async throws -> Data {
        try Task.checkCancellation()
        let input = try JSONSerialization.data(withJSONObject: [
            "action": "bootstrap", "protocolVersion": 1,
            "bindingPub": request.bindingPublicKey, "allowLaunch": false,
        ])
        return await withCheckedContinuation { continuation in
            queue.async {
                var output = [UInt8](repeating: 0, count: 16 * 1024)
                let written = input.withUnsafeBytes { inputBuffer in
                    output.withUnsafeMutableBufferPointer { outputBuffer in
                        motrix_safari_bootstrap_v1(
                            inputBuffer.bindMemory(to: UInt8.self).baseAddress, inputBuffer.count,
                            outputBuffer.baseAddress, outputBuffer.count
                        )
                    }
                }
                let result = written > 0 && written <= output.count
                    ? Data(output.prefix(written)) : BootstrapIPCCodec.unavailable
                continuation.resume(returning: result)
            }
        }
    }
}

@main
enum BootstrapServiceMain {
    static func main() {
        let logger = Logger(subsystem: "app.motrix.safari.bootstrap", category: "service")
        do {
            // Generated constants are part of this signed executable, never runtime input.
            let resolver = NativeBootstrapResolver()
            let desktop = BootstrapDesktopResolver()
            let configuration = try signedBootstrapConfiguration()
            let service = try BootstrapIPCService(configuration: configuration) { request in
                let result = try await desktop.resolve(allowLaunch: request.allowLaunch) {
                    try await resolver.resolve(request)
                } launch: {
                    try await BootstrapDesktopLauncher.launch(configuration: configuration)
                }
                // Neither the request, nonce, ticket nor local token enters diagnostics.
                logger.notice("Authenticated bootstrap request completed")
                return result
            }
            service.activate()
            logger.notice("Signed bootstrap service activated")
            withExtendedLifetime(service) { dispatchMain() }
        } catch {
            logger.error("Bootstrap service identity validation failed")
            exit(EXIT_FAILURE)
        }
    }
}
