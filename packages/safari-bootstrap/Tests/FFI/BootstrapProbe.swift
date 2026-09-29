import Foundation

private actor LaunchCounter {
    var count = 0
    func launch() { count += 1 }
}

/// Links the production Swift adapter and Rust library; launch is the only simulated operation.
@main enum BootstrapProbe {
    static func main() async throws {
        let allowLaunch = CommandLine.arguments.dropFirst().first != "passive"
        let input = try JSONSerialization.data(withJSONObject: [
            "action": "bootstrap", "protocolVersion": 1,
            "bindingPub": String(repeating: "A", count: 43), "allowLaunch": allowLaunch,
        ])
        let request = try BootstrapIPCRequest(data: input)
        let native = NativeBootstrapResolver()
        let launches = LaunchCounter()
        let response = try await BootstrapDesktopResolver().resolve(allowLaunch: allowLaunch) {
            try await native.resolve(request)
        } launch: { await launches.launch() }
        let result = try JSONSerialization.data(withJSONObject: [
            "response": try JSONSerialization.jsonObject(with: response),
            "launches": await launches.count,
        ])
        FileHandle.standardOutput.write(result + Data([10]))
    }
}
