import Foundation

/// Test-only process linked against the real C ABI and Swift wire validator.
/// Never embedded in the app or registered as an XPC service.
@main
enum BootstrapLinkMain {
    static func main() {
        do {
            let input = try FileHandle.standardInput.read(upToCount: 16385) ?? Data()
            let request = try BootstrapIPCRequest(data: input)
            guard !request.allowLaunch else { throw BootstrapIPCError.invalidRequest }
            var output = [UInt8](repeating: 0, count: 16384)
            let count = input.withUnsafeBytes { inputBuffer in
                output.withUnsafeMutableBufferPointer { outputBuffer in
                    motrix_safari_bootstrap_v1(
                        inputBuffer.bindMemory(to: UInt8.self).baseAddress, inputBuffer.count,
                        outputBuffer.baseAddress, outputBuffer.count
                    )
                }
            }
            guard count > 0 && count <= output.count else { throw BootstrapIPCError.invalidResponse }
            let result = Data(output.prefix(count))
            try BootstrapIPCCodec.validateResponse(result, for: request)
            // The parent captures this fixture-only response; never inherit stdout.
            FileHandle.standardOutput.write(result)
        } catch {
            FileHandle.standardError.write(Data("bootstrap-link-validation-failed\n".utf8))
            exit(EXIT_FAILURE)
        }
    }
}
