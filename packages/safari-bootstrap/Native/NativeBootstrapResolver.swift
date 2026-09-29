import Foundation

/// The C ABI is linked statically; no subprocess, argv identity, or dynamic library is accepted.
actor NativeBootstrapResolver {
    private let queue = DispatchQueue(label: "app.motrix.safari.rust-bootstrap")

    func resolve(_ request: BootstrapIPCRequest) async throws -> BootstrapDesktopProbe {
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
                        motrix_safari_bootstrap_v2(
                            inputBuffer.bindMemory(to: UInt8.self).baseAddress, inputBuffer.count,
                            outputBuffer.baseAddress, outputBuffer.count
                        )
                    }
                }
                guard written.response_len > 0, written.response_len <= output.count else {
                    continuation.resume(returning: .response(BootstrapIPCCodec.unavailable))
                    return
                }
                let result: BootstrapDesktopProbe = written.bridge_not_running == 1
                    ? .notRunning : .response(Data(output.prefix(written.response_len)))
                continuation.resume(returning: result)
            }
        }
    }
}
