import Cocoa
import ServiceManagement
import Security
import os
import UserNotifications

@main
class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let logger = Logger(subsystem: "app.motrix.safari", category: "bootstrap-registration")
    @MainActor private var pendingNotification: (title: String, body: String)?

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        let plistName = "app.motrix.safari.bootstrap.plist"
        let plist = Bundle.main.bundleURL.appendingPathComponent("Contents/Library/LaunchAgents/\(plistName)")
        // Ad-hoc transport builds have no service and cannot register one.
        guard FileManager.default.fileExists(atPath: plist.path) else { return }
        let service = SMAppService.agent(plistName: plistName)
        let sandboxed = SecTaskCreateFromSelf(nil).flatMap {
            SecTaskCopyValueForEntitlement($0, "com.apple.security.app-sandbox" as CFString, nil) as? Bool
        } ?? false
        logger.notice("Container sandbox entitlement: \(sandboxed, privacy: .public)")
        do {
            // These narrow commands support repeatable local installation and removal.
            if CommandLine.arguments.contains("--unregister-bootstrap") {
                try service.unregister()
                print("bootstrap-unregistered")
                NSApplication.shared.terminate(nil)
                return
            }
            // macOS may report .notFound for a bundled agent without a BTM record.
            if service.status == .notRegistered || service.status == .notFound { try service.register() }
            logger.notice("Bootstrap registration status: \(service.status.rawValue, privacy: .public)")
            if CommandLine.arguments.contains("--register-bootstrap") {
                print("bootstrap-status:\(service.status.rawValue)")
                NSApplication.shared.terminate(nil)
            }
        } catch {
            logger.error("Bootstrap service registration failed: \((error as NSError).code, privacy: .public)")
            if CommandLine.arguments.contains("--register-bootstrap") || CommandLine.arguments.contains("--unregister-bootstrap") {
                exit(EXIT_FAILURE)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              response.notification.request.identifier.hasPrefix("motrix.") else {
            completionHandler()
            return
        }
        let title = response.notification.request.content.title
        let body = response.notification.request.content.body
        Task { @MainActor in
            pendingNotification = (title, body)
            if let window = NSApplication.shared.windows.first(where: { $0.contentViewController is ViewController }),
               let controller = window.contentViewController as? ViewController {
                showPendingNotification(in: controller)
                window.makeKeyAndOrderFront(nil)
            }
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        completionHandler()
    }

    @MainActor func showPendingNotification(in controller: ViewController) {
        guard let pendingNotification else { return }
        controller.showNotification(title: pendingNotification.title, body: pendingNotification.body)
        self.pendingNotification = nil
    }
}
