// src/core/plugin/circuit/circuit-breaker.ts
// Per-(pluginId, hook) failure counter that auto-disables misbehaving plugins.
//
// Behaviour:
//   - 3 consecutive failures (configurable) → breaker flips open.
//   - onOpen callback fires exactly once when the breaker opens (caller wires
//     host.disable so the plugin is evicted from future chains).
//   - 24 h of silence (configurable) → breaker auto-closes and the failure
//     record is cleared (decay). A new failure after decay restarts the counter
//     from 1 rather than continuing where it left off.
//
// Architecture contract: MUST NOT import from electron, @main/, @server/, or
// @renderer/. Pure in-memory state; no I/O.

export interface CircuitBreakerOptions {
  /** Consecutive failures that flip the breaker open. Default 3. */
  failureThreshold?: number
  /** Time in ms after the last failure before counter decays. Default 24 h. */
  decayMs?: number
  /** Optional disable callback fired when breaker opens. */
  onOpen?(pluginId: string, hook: string, reason: string): void | Promise<void>
  /** Clock for testability — defaults to Date.now. */
  now?(): number
}

interface FailureRecord {
  consecutiveFailures: number
  firstFailureAt: number
  lastFailureAt: number
  open: boolean
}

export class CircuitBreaker {
  private readonly records = new Map<string, FailureRecord>()
  private readonly opts: Required<Omit<CircuitBreakerOptions, 'onOpen'>> & {
    onOpen?: CircuitBreakerOptions['onOpen']
  }

  constructor(opts: CircuitBreakerOptions = {}) {
    this.opts = {
      failureThreshold: opts.failureThreshold ?? 3,
      decayMs: opts.decayMs ?? 24 * 60 * 60 * 1000,
      now: opts.now ?? (() => Date.now()),
      onOpen: opts.onOpen,
    }
  }

  private key(pluginId: string, hook: string): string {
    return `${pluginId}#${hook}`
  }

  /** Records a successful invocation — resets the failure counter. */
  success(pluginId: string, hook: string): void {
    this.records.delete(this.key(pluginId, hook))
  }

  /**
   * Records a failure. If the consecutive count reaches `failureThreshold`,
   * flips the breaker open and fires `onOpen` (caller wires `host.disable`).
   */
  failure(pluginId: string, hook: string): void {
    const k = this.key(pluginId, hook)
    const now = this.opts.now()
    const existing = this.records.get(k)

    // Apply decay: if last failure was > decayMs ago, restart the counter.
    if (existing && now - existing.lastFailureAt > this.opts.decayMs) {
      this.records.set(k, {
        consecutiveFailures: 1,
        firstFailureAt: now,
        lastFailureAt: now,
        open: false,
      })
      return
    }

    const next: FailureRecord = existing
      ? {
          consecutiveFailures: existing.consecutiveFailures + 1,
          firstFailureAt: existing.firstFailureAt,
          lastFailureAt: now,
          open: existing.open,
        }
      : {
          consecutiveFailures: 1,
          firstFailureAt: now,
          lastFailureAt: now,
          open: false,
        }

    if (!next.open && next.consecutiveFailures >= this.opts.failureThreshold) {
      next.open = true
      void this.opts.onOpen?.(
        pluginId,
        hook,
        `consecutive failures: ${next.consecutiveFailures}`
      )
    }
    this.records.set(k, next)
  }

  /** Returns true when the breaker has tripped open and not yet decayed. */
  isOpen(pluginId: string, hook: string): boolean {
    const k = this.key(pluginId, hook)
    const r = this.records.get(k)
    if (!r) return false
    if (!r.open) return false
    // After decay, breaker auto-closes and clears the record.
    if (this.opts.now() - r.lastFailureAt > this.opts.decayMs) {
      this.records.delete(k)
      return false
    }
    return true
  }

  /** Returns the consecutive-failure count (for debugging / observability). */
  failureCount(pluginId: string, hook: string): number {
    return this.records.get(this.key(pluginId, hook))?.consecutiveFailures ?? 0
  }

  /** Clears all breaker state for the key (for tests / admin reset). */
  reset(pluginId: string, hook: string): void {
    this.records.delete(this.key(pluginId, hook))
  }
}
