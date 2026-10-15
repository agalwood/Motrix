import Foundation
import SQLite3

/// A transaction claims delivery before any system notification is submitted.
/// Reserved receipts remain unknown after a crash; they must never be replayed blindly.
public final class NotificationReceiptStore: @unchecked Sendable {
    public enum Reservation: Equatable, Sendable {
        case reserved(String)
        case duplicate
        case unknown
        case suppressed
        case rateLimited
        case failed
    }

    public enum Outcome: String, Sendable {
        case accepted, failed, suppressed, unknown
    }

    public enum StoreError: Error { case unavailable }

    private var database: OpaquePointer?
    private let lock = NSLock()
    private let retention: TimeInterval = 7 * 24 * 60 * 60
    private let capacity: Int
    private let perProfileLimit: Int
    private let installationLimit: Int
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    public init(url: URL, capacity: Int = 4096, perProfileLimit: Int = 5, installationLimit: Int = 20) throws {
        self.capacity = capacity
        self.perProfileLimit = perProfileLimit
        self.installationLimit = installationLimit
        guard sqlite3_open_v2(url.path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            sqlite3_close(database)
            database = nil
            throw StoreError.unavailable
        }
        sqlite3_busy_timeout(database, 1500)
        do {
            try execute("PRAGMA journal_mode=WAL")
            try execute("PRAGMA synchronous=FULL")
            try execute("""
                CREATE TABLE IF NOT EXISTS receipts (
                    identifier TEXT PRIMARY KEY NOT NULL,
                    profile TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    created REAL NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('reserved','accepted','failed','suppressed','unknown'))
                )
                """)
            try execute("CREATE INDEX IF NOT EXISTS receipts_created ON receipts(created)")
        } catch {
            sqlite3_close(database)
            database = nil
            throw error
        }
    }

    deinit { sqlite3_close(database) }

    public func reserve(profile: UUID?, eventID: UUID, kind: String, now: Date) throws -> Reservation {
        let partition = profile?.uuidString.lowercased() ?? "unscoped"
        let identifier = "motrix.\(partition).\(eventID.uuidString.lowercased())"
        return try transaction {
            try update("DELETE FROM receipts WHERE created < ?", numbers: [now.timeIntervalSince1970 - retention])
            if let state = try text("SELECT state FROM receipts WHERE identifier = ?", strings: [identifier]) {
                switch state {
                case "accepted": return .duplicate
                case "failed": return .failed
                case "suppressed": return .suppressed
                default: return .unknown
                }
            }
            // Never evict a recent receipt merely to make room: that would allow
            // an old accepted event to alert again when its response was lost.
            guard try count("SELECT COUNT(*) FROM receipts") < capacity else { return .suppressed }
            guard try count("SELECT COUNT(*) FROM receipts WHERE created >= ?", numbers: [now.timeIntervalSince1970 - 60]) < installationLimit,
                  try count("SELECT COUNT(*) FROM receipts WHERE profile = ? AND created >= ?", strings: [partition], numbers: [now.timeIntervalSince1970 - 60]) < perProfileLimit
            else { return .rateLimited }
            if kind == "test", try count("SELECT COUNT(*) FROM receipts WHERE profile = ? AND kind = 'test' AND created >= ?", strings: [partition], numbers: [now.timeIntervalSince1970 - 10]) > 0 {
                return .rateLimited
            }
            try update("INSERT INTO receipts(identifier, profile, kind, created, state) VALUES(?, ?, ?, ?, 'reserved')", strings: [identifier, partition, kind], numbers: [now.timeIntervalSince1970])
            return .reserved(identifier)
        }
    }

    public func complete(identifier: String, outcome: Outcome) throws {
        try transaction {
            try update("UPDATE receipts SET state = ? WHERE identifier = ? AND state = 'reserved'", strings: [outcome.rawValue, identifier])
            guard sqlite3_changes(database) == 1 else { throw StoreError.unavailable }
        }
    }

    private func transaction<T>(_ body: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    private func execute(_ sql: String) throws {
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw StoreError.unavailable }
    }

    private func statement(_ sql: String, strings: [String], numbers: [Double]) throws -> OpaquePointer {
        var prepared: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &prepared, nil) == SQLITE_OK, let prepared else {
            throw StoreError.unavailable
        }
        for (index, value) in strings.enumerated() {
            guard sqlite3_bind_text(prepared, Int32(index + 1), value, -1, transient) == SQLITE_OK else {
                sqlite3_finalize(prepared)
                throw StoreError.unavailable
            }
        }
        for (index, value) in numbers.enumerated() {
            guard sqlite3_bind_double(prepared, Int32(strings.count + index + 1), value) == SQLITE_OK else {
                sqlite3_finalize(prepared)
                throw StoreError.unavailable
            }
        }
        return prepared
    }

    private func update(_ sql: String, strings: [String] = [], numbers: [Double] = []) throws {
        let prepared = try statement(sql, strings: strings, numbers: numbers)
        defer { sqlite3_finalize(prepared) }
        guard sqlite3_step(prepared) == SQLITE_DONE else { throw StoreError.unavailable }
    }

    private func text(_ sql: String, strings: [String]) throws -> String? {
        let prepared = try statement(sql, strings: strings, numbers: [])
        defer { sqlite3_finalize(prepared) }
        let result = sqlite3_step(prepared)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW, let value = sqlite3_column_text(prepared, 0) else { throw StoreError.unavailable }
        return String(cString: value)
    }

    private func count(_ sql: String, strings: [String] = [], numbers: [Double] = []) throws -> Int {
        let prepared = try statement(sql, strings: strings, numbers: numbers)
        defer { sqlite3_finalize(prepared) }
        guard sqlite3_step(prepared) == SQLITE_ROW else { throw StoreError.unavailable }
        return Int(sqlite3_column_int64(prepared, 0))
    }
}
