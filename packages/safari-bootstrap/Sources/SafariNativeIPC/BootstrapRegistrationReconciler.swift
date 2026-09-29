/// Rebind only stale registrations; never undo a user's disabled background-item choice.
enum BootstrapRegistrationReconciler {
    @MainActor
    static func reconcile(
        status: () -> String,
        matches: () async -> Bool,
        unregister: () async throws -> Void,
        register: () throws -> Void
    ) async throws -> String {
        if status() == "requires-approval" { return "requires-approval" }
        if status() == "enabled", await matches() { return "enabled" }
        // Retry a stale registration once, then report failure instead of looping indefinitely.
        for _ in 0..<2 {
            switch status() {
            case "requires-approval": return "requires-approval"
            case "enabled": try await unregister()
            case "not-registered", "not-found": break
            default: return "failed"
            }
            try register()
            if status() == "requires-approval" { return "requires-approval" }
            if status() == "enabled", await matches() { return "enabled" }
        }
        return "failed"
    }
}
