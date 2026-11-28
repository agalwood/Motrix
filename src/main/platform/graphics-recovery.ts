import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { GraphicsRecoveryNotice } from '@shared/schemas/graphics-recovery'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'

export const GPU_FAILURE_LIMIT = 3
export const GPU_FAILURE_WINDOW_MS = 5 * 60_000
export const GPU_HEALTHY_INTERVAL_MS = 60_000

const failureSchema = z.object({
  at: z.number().int().nonnegative(),
  reason: z.string().max(100),
  exitCode: z.number().int(),
})
const recoveryStateSchema = z.object({
  version: z.literal(1),
  consecutiveFailures: z.number().int().min(0).max(GPU_FAILURE_LIMIT),
  lastFailureAt: z.number().int().nonnegative().nullable(),
  recoveryPending: z.boolean(),
  noticeId: z.uuid().nullable(),
  failures: z.array(failureSchema).max(10),
})
type RecoveryState = z.infer<typeof recoveryStateSchema>

export interface GraphicsRecoveryOptions {
  statePath: string
  hardwareAcceleration: boolean
  warn: (error: unknown, message: string) => void
  now?: () => number
}

/** Durable desktop-only policy; writes are synchronous because Chromium can
 * terminate the host immediately after another GPU process failure. */
export class GraphicsRecovery {
  private state: RecoveryState = {
    version: 1,
    consecutiveFailures: 0,
    lastFailureAt: null,
    recoveryPending: false,
    noticeId: null,
    failures: [],
  }
  private preferenceEnabled: boolean
  private readonly now: () => number
  readonly hardwareAcceleration: boolean
  readonly recoveredAtStartup: boolean

  constructor(private readonly options: GraphicsRecoveryOptions) {
    this.now = options.now ?? Date.now
    this.preferenceEnabled = options.hardwareAcceleration
    try {
      this.state = recoveryStateSchema.parse(
        JSON.parse(readFileSync(options.statePath, 'utf8'))
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        options.warn(error, 'Unable to read graphics recovery state')
      }
    }
    this.recoveredAtStartup = this.state.recoveryPending
    this.hardwareAcceleration =
      options.hardwareAcceleration && !this.recoveredAtStartup
    if (this.recoveredAtStartup && this.state.noticeId === null) {
      this.state.noticeId = randomUUID()
      this.persist()
    }
  }

  recordFailure(details: { reason: string; exitCode: number }): void {
    const at = this.now()
    this.state.failures = [...this.state.failures, { at, ...details }].slice(
      -10
    )
    // Log every GPU exit, but only explicit crashes/start failures count.
    // Explicit software mode cannot establish a hardware/driver failure.
    // When acceleration is allowed, repeated GPU failures still trigger
    // conservative recovery even if Chromium has already fallen back.
    if (
      this.hardwareAcceleration &&
      this.preferenceEnabled &&
      ['crashed', 'abnormal-exit', 'launch-failed'].includes(details.reason)
    ) {
      const previous = this.state.lastFailureAt
      const consecutive =
        previous !== null &&
        at >= previous &&
        at - previous <= GPU_FAILURE_WINDOW_MS
      this.state.consecutiveFailures = Math.min(
        GPU_FAILURE_LIMIT,
        consecutive ? this.state.consecutiveFailures + 1 : 1
      )
      this.state.lastFailureAt = at
      if (this.state.consecutiveFailures === GPU_FAILURE_LIMIT) {
        this.state.recoveryPending = true
      }
    }
    this.persist()
  }

  markHealthy(): void {
    // Once repeated failures schedule recovery, a later Chromium fallback
    // must not silently cancel it before the next launch.
    if (this.state.recoveryPending || this.state.consecutiveFailures === 0)
      return
    this.state.consecutiveFailures = 0
    this.state.lastFailureAt = null
    this.persist()
  }

  preferenceChanged(enabled: boolean): void {
    this.preferenceEnabled = enabled
    this.state.consecutiveFailures = 0
    this.state.lastFailureAt = null
    this.state.recoveryPending = false
    if (enabled) this.state.noticeId = null
    this.persist()
  }

  /** Called only after SettingsManager durably stores the disabled switch. */
  completeRecovery(): void {
    if (!this.recoveredAtStartup) return
    this.preferenceEnabled = false
    this.state.recoveryPending = false
    this.state.consecutiveFailures = 0
    this.state.lastFailureAt = null
    this.persist()
  }

  getNotice(): GraphicsRecoveryNotice | null {
    return !this.hardwareAcceleration && this.state.noticeId
      ? { id: this.state.noticeId }
      : null
  }

  acknowledgeNotice(id: string): void {
    if (id !== this.state.noticeId) return
    this.state.noticeId = null
    this.persist()
  }

  private persist(): void {
    try {
      writeFileAtomic.sync(this.options.statePath, JSON.stringify(this.state), {
        mode: 0o600,
      })
    } catch (error) {
      this.options.warn(error, 'Unable to persist graphics recovery state')
    }
  }
}
