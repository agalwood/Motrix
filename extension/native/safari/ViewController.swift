import Cocoa
import SafariServices
import UserNotifications
import WebKit

@MainActor
final class ViewController: NSViewController {
    @IBOutlet var webView: WKWebView!
    private var notificationsButton: NSButton!
    private let notificationPermission = NSTextField(wrappingLabelWithString: "")
    private var activationObserver: NSObjectProtocol?
    private let notificationTitle = NSTextField(wrappingLabelWithString: "")
    private let notificationBody = NSTextField(wrappingLabelWithString: "")

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.isHidden = true
        let title = NSTextField(labelWithString: "Motrix Extension")
        title.font = .systemFont(ofSize: 26, weight: .semibold)
        let preferences = NSButton(title: NativeStrings.value("popup.settings"), target: self,
                                   action: #selector(openPreferences))
        preferences.bezelStyle = .rounded
        notificationsButton = NSButton(title: NativeStrings.value("options.notifications.masterLabel"),
                                       target: self, action: #selector(authorizeNotifications))
        notificationsButton.bezelStyle = .rounded
        notificationsButton.isEnabled = false
        notificationPermission.font = .systemFont(ofSize: 13)
        notificationPermission.alignment = .center
        notificationTitle.font = .systemFont(ofSize: 16, weight: .semibold)
        notificationBody.font = .systemFont(ofSize: 13)
        notificationBody.isSelectable = true
        notificationTitle.isHidden = true
        notificationBody.isHidden = true
        let stack = NSStackView(views: [title, preferences, notificationPermission, notificationsButton, notificationTitle, notificationBody])
        stack.orientation = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
        ])
        activationObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.refreshNotificationPermission() }
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        (NSApplication.shared.delegate as? AppDelegate)?.showPendingNotification(in: self)
        Task { await refreshNotificationPermission() }
    }

    deinit { if let activationObserver { NotificationCenter.default.removeObserver(activationObserver) } }

    private func refreshNotificationPermission() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let status: String
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: status = "nativeAuthorized"
        case .denied: status = "nativeDenied"
        default: status = "nativeNotDetermined"
        }
        notificationPermission.stringValue = NativeStrings.value("options.notifications.\(status)")
        notificationsButton.title = NativeStrings.value(settings.authorizationStatus == .notDetermined
            ? "options.notifications.masterLabel" : "options.notifications.openSystemSettings")
        notificationsButton.isEnabled = true
    }

    func showNotification(title: String, body: String) {
        notificationTitle.stringValue = title
        notificationBody.stringValue = body
        notificationTitle.isHidden = false
        notificationBody.isHidden = false
    }

    @objc private func openPreferences() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: "app.motrix.safari.extension") { _ in }
    }

    @objc private func authorizeNotifications() {
        notificationsButton.isEnabled = false
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if settings.authorizationStatus == .notDetermined {
                _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert])
            } else {
                // Open the fixed system app; caller-controlled URLs and arguments are never accepted.
                let appURL = URL(fileURLWithPath: "/System/Applications/System Settings.app", isDirectory: true)
                _ = try? await NSWorkspace.shared.openApplication(at: appURL, configuration: NSWorkspace.OpenConfiguration())
            }
            await refreshNotificationPermission()
        }
    }
}
