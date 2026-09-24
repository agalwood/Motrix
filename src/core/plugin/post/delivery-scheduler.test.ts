import { describe, expect, it, vi } from 'vitest'
import {
  PostDeliveryScheduler,
  type PostDeliverySchedulerOptions,
} from './delivery-scheduler'
import type {
  BreakerFailureInput,
  CompletePostDeliveryInput,
  DeadLetterPostDeliveryInput,
  PostDeliveryBreakerPermit,
  PostDeliveryBreakerState,
  PostDeliveryClaim,
  PostDeliveryClock,
  PostDeliveryPluginInvoker,
  PostDeliveryPolicyProvider,
  PostDeliveryRecord,
  PostDeliveryRepository,
  RetryPostDeliveryInput,
} from './delivery-types'

interface BreakerData {
  failures: number[]
  openUntil?: number
  activePermit?: PostDeliveryBreakerPermit & { expiresAt: number }
}

class MemoryRepository implements PostDeliveryRepository {
  readonly rows: PostDeliveryRecord[]
  readonly claims: string[] = []
  readonly breakers = new Map<string, BreakerData>()
  reclaimed = { deliveries: 0, breakerProbes: 0 }

  constructor(rows: PostDeliveryRecord[]) {
    this.rows = rows
  }

  async recoverExpiredLeases(now: number) {
    let deliveries = 0
    let breakerProbes = 0
    for (const row of this.rows) {
      if (
        row.status === 'delivering' &&
        row.leaseExpiresAt !== undefined &&
        row.leaseExpiresAt <= now
      ) {
        row.status = 'pending'
        row.leaseToken = undefined
        row.leaseExpiresAt = undefined
        deliveries += 1
      }
    }
    for (const breaker of this.breakers.values()) {
      if (
        breaker.activePermit?.mode === 'half_open' &&
        breaker.activePermit.expiresAt <= now
      ) {
        breaker.activePermit = undefined
        breakerProbes += 1
      }
    }
    this.reclaimed = { deliveries, breakerProbes }
    return this.reclaimed
  }

  async listClaimablePluginIds(now: number) {
    return this.rows
      .filter((row) => row.status === 'pending' && row.nextAttemptAt <= now)
      .map((row) => row.executable.pluginId)
  }

  async claimNextForPlugin(input: {
    pluginId: string
    now: number
    leaseToken: string
    leaseExpiresAt: number
    maxAttempts: number
    maxActiveAgeMs: number
  }) {
    const row = this.rows.find(
      (candidate) =>
        candidate.status === 'pending' &&
        candidate.nextAttemptAt <= input.now &&
        candidate.executable.pluginId === input.pluginId
    )
    if (!row) return undefined
    if (row.attemptCount >= input.maxAttempts) {
      row.status = 'dead_letter'
      row.terminalReason = 'attempt_limit'
      return undefined
    }
    if (input.now - row.createdAt >= input.maxActiveAgeMs) {
      row.status = 'dead_letter'
      row.terminalReason = 'age_limit'
      return undefined
    }
    row.status = 'delivering'
    row.attemptCount += 1
    row.leaseToken = input.leaseToken
    row.leaseExpiresAt = input.leaseExpiresAt
    this.claims.push(input.pluginId)
    return row as PostDeliveryClaim
  }

  async acquireBreakerPermit(
    pluginId: string,
    now: number,
    token: string,
    leaseExpiresAt: number
  ) {
    const breaker = this.breakers.get(pluginId) ?? { failures: [] }
    this.breakers.set(pluginId, breaker)
    if (breaker.activePermit && breaker.activePermit.expiresAt > now) {
      return undefined
    }
    if (breaker.openUntil !== undefined && breaker.openUntil > now) {
      return undefined
    }
    const permit: PostDeliveryBreakerPermit & { expiresAt: number } = {
      mode: breaker.openUntil === undefined ? 'closed' : 'half_open',
      token,
      expiresAt: leaseExpiresAt,
    }
    breaker.activePermit = permit
    return { mode: permit.mode, token: permit.token }
  }

  async releaseBreakerPermit(
    pluginId: string,
    permit: PostDeliveryBreakerPermit
  ) {
    const breaker = this.breakers.get(pluginId)
    if (breaker?.activePermit?.token === permit.token) {
      breaker.activePermit = undefined
    }
  }

  async complete(
    input: CompletePostDeliveryInput,
    breakerInput: {
      pluginId: string
      permit: PostDeliveryBreakerPermit
      now: number
    }
  ) {
    const row = this.ownedRow(input.deliveryId, input.leaseToken)
    if (!row) return false
    row.status = 'delivered'
    row.leaseToken = undefined
    row.leaseExpiresAt = undefined
    const breaker = this.breakers.get(breakerInput.pluginId)
    if (breaker) {
      breaker.failures = []
      breaker.openUntil = undefined
      breaker.activePermit = undefined
    }
    return true
  }

  async retry(
    input: RetryPostDeliveryInput,
    breakerInput: BreakerFailureInput
  ) {
    const row = this.ownedRow(input.deliveryId, input.leaseToken)
    if (!row) {
      return {
        updated: false,
        breaker: this.breakerState(breakerInput.pluginId),
      }
    }
    row.status = 'pending'
    row.nextAttemptAt = input.nextAttemptAt
    row.leaseToken = undefined
    row.leaseExpiresAt = undefined
    const breaker = this.breakers.get(breakerInput.pluginId) ?? { failures: [] }
    this.breakers.set(breakerInput.pluginId, breaker)
    breaker.activePermit = undefined
    breaker.failures = breaker.failures.filter(
      (failure) => failure >= breakerInput.now - breakerInput.windowMs
    )
    breaker.failures.push(breakerInput.now)
    if (
      breakerInput.permit.mode === 'half_open' ||
      breaker.failures.length >= breakerInput.threshold
    ) {
      breaker.openUntil = breakerInput.now + breakerInput.pauseMs
    }
    return {
      updated: true,
      breaker: this.breakerState(breakerInput.pluginId),
    }
  }

  async deadLetter(
    input: DeadLetterPostDeliveryInput,
    breakerInput: { pluginId: string; permit: PostDeliveryBreakerPermit }
  ) {
    const row = this.ownedRow(input.deliveryId, input.leaseToken)
    if (!row) return false
    row.status = input.terminalStatus
    row.terminalReason = input.reason
    row.leaseToken = undefined
    row.leaseExpiresAt = undefined
    await this.releaseBreakerPermit(breakerInput.pluginId, breakerInput.permit)
    return true
  }

  private ownedRow(deliveryId: string, leaseToken: string) {
    return this.rows.find(
      (row) =>
        row.deliveryId === deliveryId &&
        row.status === 'delivering' &&
        row.leaseToken === leaseToken
    )
  }

  private breakerState(pluginId: string): PostDeliveryBreakerState {
    const breaker = this.breakers.get(pluginId) ?? { failures: [] }
    const state =
      breaker.openUntil === undefined
        ? 'closed'
        : breaker.activePermit?.mode === 'half_open'
          ? 'half_open'
          : 'open'
    return {
      pluginId,
      state,
      failureCount: breaker.failures.length,
      openUntil: breaker.openUntil,
    }
  }
}

function row(pluginId: string, index: number): PostDeliveryRecord {
  const deliveryId = `${pluginId}-${index}`
  return {
    deliveryId,
    deduplicationKey: deliveryId,
    hook: 'afterComplete',
    executable: { pluginId, version: '1.0.0', digest: 'a'.repeat(64) },
    createdGeneration: 1,
    requiredPermissions: ['metadata'],
    createdEffectivePermissions: ['http', 'metadata'],
    occurrenceId: `occ-${deliveryId}`,
    taskId: `task-${deliveryId}`,
    occurredAt: 0,
    canonicalPayload: '{}',
    payloadBytes: 2,
    permissionSnapshotBytes: 31,
    reservedBytes: 545,
    createdAt: 0,
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: 0,
  }
}

function testClock(
  initial = 0
): PostDeliveryClock & { set(now: number): void } {
  let now = initial
  return {
    now: () => now,
    set: (value) => {
      now = value
    },
    sleep: async (ms, signal) => {
      if (signal.aborted) throw new Error('aborted')
      now += ms
    },
  }
}

function policy(
  currentEffectivePermissions: readonly string[] = ['metadata']
): PostDeliveryPolicyProvider {
  return {
    acquire: async () => ({
      kind: 'authorized',
      lease: {
        currentGeneration: 2,
        currentEffectivePermissions,
        signal: new AbortController().signal,
        release: () => {},
      },
    }),
  }
}

function idFactory(): () => string {
  let id = 0
  return () => `id-${++id}`
}

function scheduler(
  repository: MemoryRepository,
  invoker: PostDeliveryPluginInvoker,
  overrides: {
    clock?: PostDeliveryClock
    policy?: PostDeliveryPolicyProvider
    claimBatch?: number
    globalWorkers?: number
    breakerThreshold?: number
    maxAttempts?: number
    maxActiveAgeMs?: number
    maintenance?: PostDeliverySchedulerOptions['maintenance']
  } = {}
) {
  return new PostDeliveryScheduler({
    repository,
    policy: overrides.policy ?? policy(),
    invoker,
    clock: overrides.clock ?? testClock(),
    jitter: { factor: () => 1 },
    idFactory: idFactory(),
    maintenance: overrides.maintenance,
    config: {
      leaseMs: 30_000,
      claimBatch: overrides.claimBatch ?? 64,
      globalWorkers: overrides.globalWorkers ?? 8,
      breakerThreshold: overrides.breakerThreshold ?? 5,
      maxAttempts: overrides.maxAttempts ?? 12,
      maxActiveAgeMs: overrides.maxActiveAgeMs ?? 7 * 24 * 60 * 60_000,
      breakerWindowMs: 60_000,
      breakerPauseMs: 60_000,
      baseDelayMs: 100,
      delayCapMs: 60_000,
    },
  })
}

const successfulInvoker = (calls: string[]): PostDeliveryPluginInvoker => ({
  invoke: async ({ record, invocationId }) => {
    calls.push(record.deliveryId)
    return {
      kind: 'success',
      receipt: { deliveryId: record.deliveryId, invocationId },
    }
  },
})

describe('PostDeliveryScheduler', () => {
  it('reclaims an expired delivery lease on restart before invoking', async () => {
    const expired = row('a', 1)
    expired.status = 'delivering'
    expired.leaseToken = 'crashed-owner'
    expired.leaseExpiresAt = 50
    const repository = new MemoryRepository([expired])
    const clock = testClock(100)
    const calls: string[] = []

    const result = await scheduler(repository, successfulInvoker(calls), {
      clock,
      claimBatch: 1,
    }).drainOnce()

    expect(repository.reclaimed.deliveries).toBe(1)
    expect(result).toMatchObject({ claimed: 1, delivered: 1 })
    expect(calls).toEqual(['a-1'])
  })

  it('reclaims an expired half-open probe lease on restart', async () => {
    const repository = new MemoryRepository([])
    repository.breakers.set('a', {
      failures: [1],
      activePermit: {
        mode: 'half_open',
        token: 'crashed-probe',
        expiresAt: 50,
      },
    })
    const instance = scheduler(repository, successfulInvoker([]), {
      clock: testClock(50),
    })
    await instance.recover()
    expect(repository.reclaimed.breakerProbes).toBe(1)
  })

  it('coalesces concurrent restart recovery', async () => {
    const repository = new MemoryRepository([])
    const recover = vi.spyOn(repository, 'recoverExpiredLeases')
    const instance = scheduler(repository, successfulInvoker([]))
    await Promise.all([
      instance.recover(),
      instance.recover(),
      instance.recover(),
    ])
    expect(recover).toHaveBeenCalledOnce()
  })

  it('reconciles quota state and runs the 30-day retention pass during recovery', async () => {
    const repository = new MemoryRepository([])
    const reconcile = vi.fn(async () => ({}))
    const maintain = vi.fn(async () => ({ compacted: 0, pruned: 0 }))
    const now = 40 * 24 * 60 * 60_000

    await scheduler(repository, successfulInvoker([]), {
      clock: testClock(now),
      maintenance: { reconcile, maintain },
    }).recover()

    expect(reconcile).toHaveBeenCalledOnce()
    expect(maintain).toHaveBeenCalledExactlyOnceWith(now, 30 * 24 * 60 * 60_000)
  })

  it('rotates plugins round-robin instead of draining one plugin first', async () => {
    const repository = new MemoryRepository([
      row('a', 1),
      row('a', 2),
      row('a', 3),
      row('b', 1),
    ])
    const calls: string[] = []
    await scheduler(repository, successfulInvoker(calls), {
      claimBatch: 4,
      globalWorkers: 1,
    }).drainOnce()
    expect(repository.claims).toEqual(['a', 'b', 'a', 'a'])
    expect(calls).toEqual(['a-1', 'b-1', 'a-2', 'a-3'])
  })

  it('allows global parallelism while keeping each plugin at concurrency one', async () => {
    const repository = new MemoryRepository([
      row('a', 1),
      row('a', 2),
      row('b', 1),
      row('b', 2),
    ])
    const active = new Map<string, number>()
    const maximum = new Map<string, number>()
    const invoker: PostDeliveryPluginInvoker = {
      invoke: async ({ record, invocationId }) => {
        const pluginId = record.executable.pluginId
        const count = (active.get(pluginId) ?? 0) + 1
        active.set(pluginId, count)
        maximum.set(pluginId, Math.max(maximum.get(pluginId) ?? 0, count))
        await new Promise((resolve) => setTimeout(resolve, 1))
        active.set(pluginId, count - 1)
        return {
          kind: 'success',
          receipt: {
            deliveryId: record.deliveryId,
            invocationId,
          },
        }
      },
    }
    await scheduler(repository, invoker, {
      claimBatch: 4,
      globalWorkers: 2,
    }).drainOnce()
    expect(maximum).toEqual(
      new Map([
        ['a', 1],
        ['b', 1],
      ])
    )
  })

  it('passes only creation-time permissions intersected with live grants', async () => {
    const repository = new MemoryRepository([row('a', 1)])
    let received: readonly string[] = []
    let generation = -1
    const invoker: PostDeliveryPluginInvoker = {
      invoke: async ({
        record,
        invocationId,
        effectivePermissions,
        permissionGeneration,
      }) => {
        received = effectivePermissions
        generation = permissionGeneration
        return {
          kind: 'success',
          receipt: {
            deliveryId: record.deliveryId,
            invocationId,
          },
        }
      },
    }
    await scheduler(repository, invoker, {
      claimBatch: 1,
      policy: policy(['metadata', 'notify']),
    }).drainOnce()
    expect(received).toEqual(['metadata'])
    expect(generation).toBe(2)
  })

  it('dead-letters before invocation when a required grant was revoked', async () => {
    const repository = new MemoryRepository([row('a', 1)])
    const calls: string[] = []
    const result = await scheduler(repository, successfulInvoker(calls), {
      claimBatch: 1,
      policy: policy(['notify']),
    }).drainOnce()
    expect(result.deadLettered).toBe(1)
    expect(repository.rows[0].terminalReason).toBe('permission_revoked')
    expect(calls).toEqual([])
  })

  it('dead-letters at the exact active-age boundary without invoking', async () => {
    const repository = new MemoryRepository([row('a', 1)])
    const calls: string[] = []
    const result = await scheduler(repository, successfulInvoker(calls), {
      clock: testClock(60 * 60_000),
      claimBatch: 1,
      maxActiveAgeMs: 60 * 60_000,
    }).drainOnce()
    expect(result.claimed).toBe(0)
    expect(repository.rows[0].terminalReason).toBe('age_limit')
    expect(calls).toEqual([])
  })

  it('terminalizes a reclaimed row already at the attempt limit before incrementing', async () => {
    const exhausted = row('a', 1)
    exhausted.attemptCount = 3
    const repository = new MemoryRepository([exhausted])
    const calls: string[] = []
    const result = await scheduler(repository, successfulInvoker(calls), {
      claimBatch: 1,
      maxAttempts: 3,
    }).drainOnce()
    expect(result.claimed).toBe(0)
    expect(exhausted.status).toBe('dead_letter')
    expect(exhausted.terminalReason).toBe('attempt_limit')
    expect(calls).toEqual([])
  })

  it('treats a superseded executable as a permanent lifecycle outcome', async () => {
    const repository = new MemoryRepository([row('a', 1)])
    const calls: string[] = []
    const result = await scheduler(repository, successfulInvoker(calls), {
      claimBatch: 1,
      policy: {
        acquire: async () => ({ kind: 'permanent', reason: 'superseded' }),
      },
    }).drainOnce()
    expect(result.deadLettered).toBe(1)
    expect(repository.rows[0].terminalReason).toBe('superseded')
    expect(repository.rows[0].status).toBe('superseded')
    expect(calls).toEqual([])
  })

  it('requires a receipt matching both stable delivery and fresh invocation IDs', async () => {
    const repository = new MemoryRepository([row('a', 1)])
    const result = await scheduler(
      repository,
      {
        invoke: async () => ({
          kind: 'success',
          receipt: {
            deliveryId: 'another-delivery',
            invocationId: 'another-invocation',
          },
        }),
      },
      { claimBatch: 1 }
    ).drainOnce()
    expect(result.retried).toBe(1)
    expect(repository.rows[0].status).toBe('pending')
    expect(repository.rows[0].nextAttemptAt).toBe(100)
  })

  it('opens, pauses, and half-opens the persistent per-plugin breaker', async () => {
    const repository = new MemoryRepository([row('a', 1)])
    const clock = testClock()
    let attempts = 0
    const invoker: PostDeliveryPluginInvoker = {
      invoke: async ({ record, invocationId }) => {
        attempts += 1
        if (attempts < 3) {
          return {
            kind: 'failure',
            classification: 'retryable',
            code: 'plugin.hook.worker_crashed',
          }
        }
        return {
          kind: 'success',
          receipt: {
            deliveryId: record.deliveryId,
            invocationId,
          },
        }
      },
    }
    const instance = scheduler(repository, invoker, {
      clock,
      claimBatch: 1,
      breakerThreshold: 2,
    })

    await instance.drainOnce()
    clock.set(100)
    await instance.drainOnce()
    clock.set(300)
    await expect(instance.drainOnce()).resolves.toMatchObject({ claimed: 0 })
    clock.set(60_100)
    await expect(instance.drainOnce()).resolves.toMatchObject({ delivered: 1 })
    expect(attempts).toBe(3)
    expect(repository.rows[0].status).toBe('delivered')
  })

  it('keeps polling after a transient repository failure', async () => {
    const repository = new MemoryRepository([row('a', 1)])
    const list = vi.spyOn(repository, 'listClaimablePluginIds')
    list.mockRejectedValueOnce(new Error('sqlite busy'))
    const controller = new AbortController()
    let sleeps = 0
    const clock: PostDeliveryClock = {
      now: () => 0,
      sleep: async () => {
        sleeps += 1
        if (sleeps >= 2) controller.abort()
      },
    }

    await scheduler(repository, successfulInvoker([]), {
      clock,
      claimBatch: 1,
    }).start(controller.signal)

    expect(list).toHaveBeenCalledTimes(3)
    expect(repository.rows[0].status).toBe('delivered')
  })

  it('does not claim after shutdown aborts an in-flight breaker permit', async () => {
    const repository = new MemoryRepository([row('a', 1)])
    let releasePermit!: (permit: PostDeliveryBreakerPermit) => void
    vi.spyOn(repository, 'acquireBreakerPermit').mockImplementation(
      async (_pluginId, _now, token) =>
        new Promise<PostDeliveryBreakerPermit>((resolve) => {
          releasePermit = resolve
          void token
        })
    )
    const controller = new AbortController()
    const running = scheduler(repository, successfulInvoker([]), {
      claimBatch: 1,
    }).start(controller.signal)
    await vi.waitFor(() => expect(releasePermit).toBeTypeOf('function'))

    controller.abort()
    releasePermit({ mode: 'closed', token: 'permit-after-abort' })
    await running

    expect(repository.claims).toEqual([])
  })
})
