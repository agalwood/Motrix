interface CacheEntry<T> {
  result: Promise<T>
  settled: boolean
}

/**
 * In-flight and settled results of keyed idempotent operations, indexed by an
 * opaque scope key (callers bind client identity + idempotencyKey into it). A
 * retransmit of the same logical operation (lost response, reconnect replay)
 * awaits or receives the original result instead of re-executing. Failures
 * are evicted on rejection so a retry re-executes. Capacity eviction only
 * ever removes SETTLED entries: a pending operation may span its entire
 * download, and evicting it would let a replay re-dispatch the same
 * operation as a duplicate — the exact bug this cache exists to prevent.
 */
export class IdempotencyCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()

  constructor(private readonly maxKeys = 500) {}

  run(scopeKey: string, exec: () => Promise<T>): Promise<T> {
    const known = this.entries.get(scopeKey)
    if (known) return known.result

    const entry: CacheEntry<T> = { result: exec(), settled: false }
    if (this.entries.size >= this.maxKeys) {
      // Evict the oldest SETTLED entry only; if every entry is somehow still
      // pending, overshoot the cap rather than break a live operation's dedup.
      for (const [k, e] of this.entries) {
        if (e.settled) {
          this.entries.delete(k)
          break
        }
      }
    }
    this.entries.set(scopeKey, entry)
    entry.result.then(
      () => {
        entry.settled = true
      },
      () => {
        // A failed operation must not poison its key — the retry re-executes.
        // Delete by identity so a stale rejection can never remove a newer
        // entry that has since reused the key.
        if (this.entries.get(scopeKey) === entry) {
          this.entries.delete(scopeKey)
        }
      }
    )
    return entry.result
  }
}
