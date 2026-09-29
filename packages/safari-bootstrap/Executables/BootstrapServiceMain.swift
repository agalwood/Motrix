import Foundation
import os

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
            let registration = try BootstrapRegistrationService(configuration: configuration)
            registration.activate()
            service.activate()
            logger.notice("Signed bootstrap service activated")
            withExtendedLifetime((service, registration)) { dispatchMain() }
        } catch {
            logger.error("Bootstrap service identity validation failed")
            exit(EXIT_FAILURE)
        }
    }
}
