import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  NOOP_POST_DELIVERY_OBSERVABILITY,
  type PostDeliveryObservability,
  safeObserve,
} from './delivery-observability'
import {
  computeRetryDelayMs,
  DEFAULT_POST_DELIVERY_SCHEDULER_CONFIG,
  intersectPermissions,
  missingRequiredPermissions,
  type PostDeliveryBreakerPermit,
  type PostDeliveryClaim,
  type PostDeliveryClock,
  type PostDeliveryInvocationResult,
  type PostDeliveryJitter,
  type PostDeliveryPermanentReason,
  type PostDeliveryPluginInvoker,
  type PostDeliveryPolicyDecision,
  type PostDeliveryPolicyProvider,
  type PostDeliveryRepository,
  type PostDeliverySchedulerConfig,
  PostDeliverySchedulerConfigSchema,
} from './delivery-types'

const SYSTEM_CLOCK: PostDeliveryClock = {
  now: () => Date.now(),
  sleep: async (ms, signal) => {
    await delay(ms, undefined, { signal })
  },
}

const SYSTEM_JITTER: PostDeliveryJitter = {
  factor: () => 0.75 + Math.random() * 0.5,
}

export interface PostDeliverySchedulerOptions {
  repository: PostDeliveryRepository
  policy: PostDeliveryPolicyProvider
  invoker: PostDeliveryPluginInvoker
  config?: Partial<PostDeliverySchedulerConfig>
  clock?: PostDeliveryClock
  jitter?: PostDeliveryJitter
  observability?: PostDeliveryObservability
  idFactory?: () => string
  maintenance?: {
    reconcile(): Promise<unknown>
    maintain(
      now: number,
      terminalRetentionMs: number
    ): Promise<{ compacted: number; pruned: number }>
  }
}

export interface PostDeliveryBatchResult {
  claimed: number
  delivered: number
  retried: number
  deadLettered: number
  leaseLost: number
}

type RowOutcome = keyof Omit<PostDeliveryBatchResult, 'claimed'>

const MAINTENANCE_INTERVAL_MS = 60 * 60_000

function isAbortRequested(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

export class PostDeliveryScheduler {
  private readonly config: PostDeliverySchedulerConfig
  private readonly clock: PostDeliveryClock
  private readonly jitter: PostDeliveryJitter
  private readonly observability: PostDeliveryObservability
  private readonly idFactory: () => string
  private cursor?: string
  private drainInFlight?: Promise<PostDeliveryBatchResult>
  private recoveryInFlight?: Promise<void>
  private recovered = false
  private nextMaintenanceAt = 0

  constructor(private readonly options: PostDeliverySchedulerOptions) {
    this.config = PostDeliverySchedulerConfigSchema.parse(options.config ?? {})
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.jitter = options.jitter ?? SYSTEM_JITTER
    this.observability =
      options.observability ?? NOOP_POST_DELIVERY_OBSERVABILITY
    this.idFactory = options.idFactory ?? randomUUID
  }

  async recover(): Promise<void> {
    if (this.recovered) return
    if (this.recoveryInFlight) return this.recoveryInFlight
    const operation = this.runRecovery().finally(() => {
      if (this.recoveryInFlight === operation) this.recoveryInFlight = undefined
    })
    this.recoveryInFlight = operation
    return operation
  }

  private async runRecovery(): Promise<void> {
    const now = this.clock.now()
    await this.options.maintenance?.reconcile()
    const result = await this.storage('recoverExpiredLeases', () =>
      this.options.repository.recoverExpiredLeases(now)
    )
    await this.options.maintenance?.maintain(
      now,
      this.config.terminalRetentionMs
    )
    this.nextMaintenanceAt = now + MAINTENANCE_INTERVAL_MS
    this.recovered = true
    safeObserve(this.observability, {
      type: 'plugin.post.recovery_finished',
      at: now,
      reclaimedDeliveries: result.deliveries,
      reclaimedBreakerProbes: result.breakerProbes,
    })
  }

  async start(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.recover()
        if (signal.aborted) break
        await this.maintainIfDue()
        if (signal.aborted) break
        const result = await this.drainOnce(signal)
        if (result.claimed === 0 && !signal.aborted) {
          await this.sleepUntilNextPoll(signal)
        }
      } catch {
        if (signal.aborted) break
        await this.sleepUntilNextPoll(signal)
      }
    }
  }

  drainOnce(signal?: AbortSignal): Promise<PostDeliveryBatchResult> {
    if (this.drainInFlight) return this.drainInFlight
    const operation = this.runBatch(signal).finally(() => {
      if (this.drainInFlight === operation) this.drainInFlight = undefined
    })
    this.drainInFlight = operation
    return operation
  }

  private async runBatch(
    signal?: AbortSignal
  ): Promise<PostDeliveryBatchResult> {
    if (!this.recovered) await this.recover()
    const result: PostDeliveryBatchResult = {
      claimed: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    }
    const runningPlugins = new Set<string>()
    const running = new Map<Promise<RowOutcome>, string>()

    while (
      result.claimed < this.config.claimBatch &&
      !isAbortRequested(signal)
    ) {
      let launched = false
      if (running.size < this.config.globalWorkers) {
        const pluginIds = this.rotate(
          await this.storage('listClaimablePluginIds', () =>
            this.options.repository.listClaimablePluginIds(this.clock.now())
          )
        )
        for (const pluginId of pluginIds) {
          if (
            isAbortRequested(signal) ||
            result.claimed >= this.config.claimBatch ||
            running.size >= this.config.globalWorkers
          ) {
            break
          }
          if (runningPlugins.has(pluginId)) continue
          const claimed = await this.claim(pluginId, signal)
          this.cursor = pluginId
          if (!claimed) continue
          const task = this.execute(claimed.record, claimed.permit).catch(
            (error) => {
              this.observeStorageError('deliveryTransition', error)
              return 'leaseLost' as const
            }
          )
          launched = true
          result.claimed += 1
          runningPlugins.add(pluginId)
          running.set(task, pluginId)
          void task.finally(() => {
            running.delete(task)
            runningPlugins.delete(pluginId)
          })
        }
      }

      if (running.size === 0) break
      if (!launched || running.size >= this.config.globalWorkers) {
        const outcome = await Promise.race(running.keys())
        result[outcome] += 1
      }
    }

    while (running.size > 0) {
      const outcome = await Promise.race(running.keys())
      result[outcome] += 1
    }
    return result
  }

  private rotate(pluginIds: readonly string[]): readonly string[] {
    const sorted = [...new Set(pluginIds)].sort()
    const cursor = this.cursor
    if (!cursor) return sorted
    const firstAfterCursor = sorted.findIndex((pluginId) => pluginId > cursor)
    if (firstAfterCursor < 0) return sorted
    return [
      ...sorted.slice(firstAfterCursor),
      ...sorted.slice(0, firstAfterCursor),
    ]
  }

  private async claim(
    pluginId: string,
    signal?: AbortSignal
  ): Promise<
    | {
        record: PostDeliveryClaim
        permit: PostDeliveryBreakerPermit
      }
    | undefined
  > {
    const now = this.clock.now()
    const breakerToken = this.idFactory()
    const leaseExpiresAt = now + this.config.leaseMs
    const permit = await this.storage('acquireBreakerPermit', () =>
      this.options.repository.acquireBreakerPermit(
        pluginId,
        now,
        breakerToken,
        leaseExpiresAt
      )
    )
    if (!permit) return undefined
    if (signal?.aborted) {
      await this.releasePermit(pluginId, permit)
      return undefined
    }

    const leaseToken = this.idFactory()
    let claim: PostDeliveryClaim | undefined
    try {
      claim = await this.storage('claimNextForPlugin', () =>
        this.options.repository.claimNextForPlugin({
          pluginId,
          now,
          leaseToken,
          leaseExpiresAt,
          maxAttempts: this.config.maxAttempts,
          maxActiveAgeMs: this.config.maxActiveAgeMs,
        })
      )
    } catch (error) {
      await this.releasePermit(pluginId, permit)
      throw error
    }
    if (!claim) {
      await this.releasePermit(pluginId, permit)
      return undefined
    }
    return { record: claim, permit }
  }

  private async execute(
    record: PostDeliveryClaim,
    permit: PostDeliveryBreakerPermit
  ): Promise<RowOutcome> {
    const invocationStartedAt = this.clock.now()
    const invocationId = this.idFactory()
    safeObserve(this.observability, {
      type: 'plugin.post.claimed',
      at: invocationStartedAt,
      pluginId: record.executable.pluginId,
      hook: record.hook,
      deliveryId: record.deliveryId,
      attemptCount: record.attemptCount,
      queueLatencyMs: Math.max(0, invocationStartedAt - record.createdAt),
    })

    if (invocationStartedAt - record.createdAt >= this.config.maxActiveAgeMs) {
      return this.makePermanent(
        record,
        permit,
        invocationId,
        'age_limit',
        'plugin.post.dead_letter',
        invocationStartedAt
      )
    }
    if (record.attemptCount > this.config.maxAttempts) {
      return this.makePermanent(
        record,
        permit,
        invocationId,
        'attempt_limit',
        'plugin.post.dead_letter',
        invocationStartedAt
      )
    }

    let decision: PostDeliveryPolicyDecision
    try {
      decision = await this.options.policy.acquire(record)
    } catch (error) {
      return this.makeRetryable(
        record,
        permit,
        invocationId,
        'plugin.post.retryable',
        error instanceof Error ? error.message : String(error),
        invocationStartedAt
      )
    }

    if (decision.kind === 'permanent') {
      return this.makePermanent(
        record,
        permit,
        invocationId,
        decision.reason,
        `plugin.post.${decision.reason}`,
        invocationStartedAt,
        decision.message
      )
    }

    const { lease } = decision
    try {
      const effectivePermissions = intersectPermissions(
        record.createdEffectivePermissions,
        lease.currentEffectivePermissions
      )
      const missing = missingRequiredPermissions(
        record.requiredPermissions,
        effectivePermissions
      )
      if (missing.length > 0) {
        return await this.makePermanent(
          record,
          permit,
          invocationId,
          'permission_revoked',
          'plugin.post.permission_revoked',
          invocationStartedAt
        )
      }

      let invocation: PostDeliveryInvocationResult
      try {
        invocation = await this.options.invoker.invoke({
          record,
          invocationId,
          permissionGeneration: lease.currentGeneration,
          effectivePermissions,
          signal: lease.signal,
        })
      } catch (error) {
        return await this.makeRetryable(
          record,
          permit,
          invocationId,
          'plugin.post.retryable',
          error instanceof Error ? error.message : String(error),
          invocationStartedAt
        )
      }

      if (invocation.kind === 'failure') {
        if (invocation.classification === 'permanent') {
          return await this.makePermanent(
            record,
            permit,
            invocationId,
            invocation.permanentReason ?? 'output_invalid',
            invocation.code,
            invocationStartedAt,
            invocation.message
          )
        }
        return await this.makeRetryable(
          record,
          permit,
          invocationId,
          invocation.code,
          invocation.message,
          invocationStartedAt
        )
      }

      if (
        invocation.receipt.deliveryId !== record.deliveryId ||
        invocation.receipt.invocationId !== invocationId
      ) {
        return await this.makeRetryable(
          record,
          permit,
          invocationId,
          'plugin.hook.concurrent_protocol_violation',
          'post-Hook exit did not match the active delivery and invocation',
          invocationStartedAt
        )
      }

      const completedAt = this.clock.now()
      const updated = await this.options.repository.complete(
        {
          deliveryId: record.deliveryId,
          leaseToken: record.leaseToken,
          receipt: { ...invocation.receipt, completedAt },
        },
        { pluginId: record.executable.pluginId, permit, now: completedAt }
      )
      const outcome: RowOutcome = updated ? 'delivered' : 'leaseLost'
      this.observeFinish(
        record,
        invocationId,
        invocationStartedAt,
        updated ? 'delivered' : 'retry',
        updated ? undefined : 'plugin.post.lease_lost'
      )
      return outcome
    } finally {
      await lease.release()
    }
  }

  private async makeRetryable(
    record: PostDeliveryClaim,
    permit: PostDeliveryBreakerPermit,
    invocationId: string,
    errorCode: string,
    errorMessage: string | undefined,
    startedAt: number
  ): Promise<RowOutcome> {
    const failedAt = this.clock.now()
    if (
      record.attemptCount >= this.config.maxAttempts ||
      failedAt - record.createdAt >= this.config.maxActiveAgeMs
    ) {
      return this.makePermanent(
        record,
        permit,
        invocationId,
        record.attemptCount >= this.config.maxAttempts
          ? 'attempt_limit'
          : 'age_limit',
        errorCode,
        startedAt,
        errorMessage
      )
    }

    const nextAttemptAt =
      failedAt +
      computeRetryDelayMs(record.attemptCount, this.config, this.jitter)
    const result = await this.options.repository.retry(
      {
        deliveryId: record.deliveryId,
        leaseToken: record.leaseToken,
        nextAttemptAt,
        errorCode,
        errorMessage,
        failedAt,
      },
      {
        pluginId: record.executable.pluginId,
        permit,
        now: failedAt,
        threshold: this.config.breakerThreshold,
        windowMs: this.config.breakerWindowMs,
        pauseMs: this.config.breakerPauseMs,
      }
    )
    if (result.breaker.state !== 'closed') {
      safeObserve(this.observability, {
        type: 'plugin.post.breaker_changed',
        at: failedAt,
        pluginId: record.executable.pluginId,
        state: result.breaker.state,
        openUntil: result.breaker.openUntil,
      })
    }
    this.observeFinish(record, invocationId, startedAt, 'retry', errorCode)
    return result.updated ? 'retried' : 'leaseLost'
  }

  private async makePermanent(
    record: PostDeliveryClaim,
    permit: PostDeliveryBreakerPermit,
    invocationId: string,
    reason: PostDeliveryPermanentReason,
    errorCode: string,
    startedAt: number,
    errorMessage?: string
  ): Promise<RowOutcome> {
    const completedAt = this.clock.now()
    const updated = await this.options.repository.deadLetter(
      {
        deliveryId: record.deliveryId,
        leaseToken: record.leaseToken,
        terminalStatus: reason === 'superseded' ? 'superseded' : 'dead_letter',
        reason,
        errorCode,
        errorMessage,
        completedAt,
      },
      { pluginId: record.executable.pluginId, permit }
    )
    this.observeFinish(
      record,
      invocationId,
      startedAt,
      'dead_letter',
      errorCode
    )
    return updated ? 'deadLettered' : 'leaseLost'
  }

  private observeFinish(
    record: PostDeliveryClaim,
    invocationId: string,
    startedAt: number,
    outcome: 'delivered' | 'retry' | 'dead_letter',
    errorCode?: string
  ): void {
    const at = this.clock.now()
    safeObserve(this.observability, {
      type: 'plugin.post.invocation_finished',
      at,
      pluginId: record.executable.pluginId,
      hook: record.hook,
      deliveryId: record.deliveryId,
      invocationId,
      durationMs: Math.max(0, at - startedAt),
      outcome,
      errorCode,
    })
  }

  private async releasePermit(
    pluginId: string,
    permit: PostDeliveryBreakerPermit
  ): Promise<void> {
    await this.storage('releaseBreakerPermit', () =>
      this.options.repository.releaseBreakerPermit(pluginId, permit)
    )
  }

  private async maintainIfDue(): Promise<void> {
    const maintenance = this.options.maintenance
    const now = this.clock.now()
    if (!maintenance || now < this.nextMaintenanceAt) return
    await maintenance.maintain(now, this.config.terminalRetentionMs)
    this.nextMaintenanceAt = now + MAINTENANCE_INTERVAL_MS
  }

  private async sleepUntilNextPoll(signal: AbortSignal): Promise<void> {
    try {
      await this.clock.sleep(this.config.pollIntervalMs, signal)
    } catch (error) {
      if (!signal.aborted) throw error
    }
  }

  private async storage<T>(
    operation: string,
    run: () => Promise<T>
  ): Promise<T> {
    try {
      return await run()
    } catch (error) {
      this.observeStorageError(operation, error)
      throw error
    }
  }

  private observeStorageError(operation: string, _error: unknown): void {
    safeObserve(this.observability, {
      type: 'plugin.post.storage_error',
      at: this.clock.now(),
      operation,
      errorCode: 'plugin.post.storage_error',
    })
  }
}

export { DEFAULT_POST_DELIVERY_SCHEDULER_CONFIG }
