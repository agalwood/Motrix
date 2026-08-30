// MBP1 pre-authentication connection table (docs/bridge-pairing-protocol.md
// §4).
//
// "Connections on either route live in a pre-authentication table with hard
// deadlines and caps until MBP1 completes; they never enter the live-session
// map and cannot evict an authenticated session." This table IS that
// pre-authentication table: a generic holding area, keyed by cap and a
// per-entry deadline, that a caller uses in place of inserting an
// unauthenticated connection directly into a session map. It replaced an
// attach path that disposed a same-key session the moment a socket upgraded,
// which let an unauthenticated `/pair` connection kick a live authenticated
// one; a connection admitted here can never evict anything, because it was
// never in the live-session map to begin with.
//
// This module logs nothing at any level (§11): entries are typically
// connection/session identifiers.

export interface PreAuthTableOptions<T> {
  /** Total number of entries this table admits at once. */
  cap: number
  /** How long an admitted entry may stay before `onDeadline` fires. */
  deadlineMs: number
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number
  /** Fires for an entry that neither settles nor is otherwise removed
   *  before its deadline. */
  onDeadline: (entry: T) => void
}

interface Slot {
  timer: ReturnType<typeof setTimeout>
  admittedAt: number
}

export class PreAuthTable<T> {
  private readonly cap: number
  private readonly deadlineMs: number
  private readonly now: () => number
  private readonly onDeadline: (entry: T) => void
  private readonly entries = new Map<T, Slot>()

  constructor(opts: PreAuthTableOptions<T>) {
    this.cap = opts.cap
    this.deadlineMs = opts.deadlineMs
    this.now = opts.now ?? Date.now
    this.onDeadline = opts.onDeadline
  }

  /** Admits `entry`, arming its deadline timer. Returns `false` without any
   *  mutation if the table is already at capacity, or if `entry` is already
   *  admitted — re-admitting the same key would otherwise overwrite its slot
   *  without clearing the prior timer, leaking it. */
  admit(entry: T): boolean {
    if (this.entries.has(entry) || this.entries.size >= this.cap) {
      return false
    }
    const timer = setTimeout(() => this.fireDeadline(entry), this.deadlineMs)
    timer.unref?.()
    this.entries.set(entry, { timer, admittedAt: this.now() })
    return true
  }

  /** Removes `entry` from the table — because it authenticated or its
   *  connection closed — and cancels its deadline timer so it can never fire
   *  for a settled entry. A no-op for an entry that already left the table
   *  (settled twice, or its deadline already fired). */
  settle(entry: T): void {
    const slot = this.entries.get(entry)
    if (!slot) {
      return
    }
    clearTimeout(slot.timer)
    this.entries.delete(entry)
  }

  /**
   * Atomically removes every entry selected by `predicate`, cancelling each
   * deadline and returning the removed entries for caller-owned teardown.
   *
   * The selection and removal deliberately happen in one synchronous pass:
   * security-sensitive callers (for example credential revocation) must be
   * able to establish that no matching pre-authentication session remains
   * admitted before they begin asynchronous durable work.
   */
  takeWhere(predicate: (entry: T) => boolean): T[] {
    const taken: T[] = []
    for (const [entry, slot] of this.entries) {
      if (!predicate(entry)) continue
      clearTimeout(slot.timer)
      this.entries.delete(entry)
      taken.push(entry)
    }
    return taken
  }

  /**
   * Cancels every deadline timer and empties the table — the shutdown path.
   *
   * Pre-authentication entries never enter the live-session map, so a server
   * teardown that only drains sessions would leave these timers armed to fire
   * `onDeadline` into an already-stopped server. `unref()` keeps them from
   * holding the process open but does not stop them running while it lives, so
   * a re-enable cycle would otherwise inherit the previous instance's timers.
   */
  clear(): void {
    for (const slot of this.entries.values()) {
      clearTimeout(slot.timer)
    }
    this.entries.clear()
  }

  /** Current number of admitted, not-yet-settled entries. */
  size(): number {
    return this.entries.size
  }

  private fireDeadline(entry: T): void {
    if (!this.entries.has(entry)) {
      return
    }
    this.entries.delete(entry)
    this.onDeadline(entry)
  }
}
