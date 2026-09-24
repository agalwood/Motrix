import { materializePostDeliveries } from '@core/plugin/post/delivery-materializer'
import {
  POST_DELIVERY_CORE_RESERVE_BYTES,
  PostDeliveryQuotaConfigSchema,
} from '@core/plugin/post/delivery-types'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './migrations'
import { SqlitePostDeliveryRepository } from './post-delivery-repository'

describe('SqlitePostDeliveryRepository', () => {
  let db: Database.Database
  let repository: SqlitePostDeliveryRepository

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    repository = new SqlitePostDeliveryRepository(db)
  })

  afterEach(() => db.close())

  it('atomically admits, deduplicates, reserves quota, and records a bounded rejection', () => {
    repository.setQuotaConfig(
      PostDeliveryQuotaConfigSchema.parse({ pluginActiveRows: 1 })
    )
    const first = admission('occ-1', 1_000)
    const second = admission('occ-2', 2_000)

    expect(repository.admitMany([first])).toEqual({
      admitted: 1,
      deduplicated: 0,
      rejected: 0,
    })
    expect(repository.admitMany([first])).toEqual({
      admitted: 0,
      deduplicated: 1,
      rejected: 0,
    })
    expect(repository.admitMany([second])).toEqual({
      admitted: 0,
      deduplicated: 0,
      rejected: 1,
    })

    expect(tableCount(db, 'plugin_post_deliveries')).toBe(1)
    expect(tableCount(db, 'plugin_post_quota_buckets')).toBe(1)
    expect(
      db
        .prepare(
          `SELECT active_rows FROM plugin_post_quota_ledger
           WHERE scope_key='global'`
        )
        .get()
    ).toEqual({ active_rows: 1 })
  })

  it('joins a caller-owned terminal transaction and rolls admission back with it', () => {
    expect(() =>
      db.transaction(() => {
        repository.admitManyInCurrentTransaction([
          admission('occ-rollback', 1_000),
        ])
        throw new Error('terminal write failed')
      })()
    ).toThrow('terminal write failed')

    expect(tableCount(db, 'plugin_post_deliveries')).toBe(0)
    expect(tableCount(db, 'plugin_post_quota_ledger')).toBe(0)
  })

  it('claims with CAS and recovers only expired delivery leases', async () => {
    const row = admission('occ-claim', 1_000)
    repository.admitMany([row])
    const permit = await repository.acquireBreakerPermit(
      row.executable.pluginId,
      1_000,
      'breaker-token',
      10_000
    )
    expect(permit).toEqual({ mode: 'closed', token: 'breaker-token' })

    const claim = await repository.claimNextForPlugin({
      pluginId: row.executable.pluginId,
      now: 1_000,
      leaseToken: 'lease-token',
      leaseExpiresAt: 2_000,
      maxAttempts: 12,
      maxActiveAgeMs: 86_400_000,
    })
    expect(claim).toMatchObject({
      deliveryId: row.deliveryId,
      status: 'delivering',
      attemptCount: 1,
      leaseToken: 'lease-token',
    })
    expect(await repository.recoverExpiredLeases(1_999)).toEqual({
      deliveries: 0,
      breakerProbes: 0,
    })
    expect(await repository.recoverExpiredLeases(2_000)).toEqual({
      deliveries: 1,
      breakerProbes: 0,
    })
  })

  it('completes row, compact receipt, quota release, and breaker close in one transaction', async () => {
    const row = admission('occ-complete', 1_000)
    repository.admitMany([row])
    const permit = (await repository.acquireBreakerPermit(
      row.executable.pluginId,
      1_000,
      'permit',
      9_000
    ))!
    const claim = (await repository.claimNextForPlugin({
      pluginId: row.executable.pluginId,
      now: 1_000,
      leaseToken: 'lease',
      leaseExpiresAt: 9_000,
      maxAttempts: 12,
      maxActiveAgeMs: 86_400_000,
    }))!

    await expect(
      repository.complete(
        {
          deliveryId: claim.deliveryId,
          leaseToken: claim.leaseToken,
          receipt: {
            deliveryId: claim.deliveryId,
            invocationId: 'invoke-1',
            completedAt: 1_500,
          },
        },
        { pluginId: row.executable.pluginId, permit, now: 1_500 }
      )
    ).resolves.toBe(true)

    const stored = db
      .prepare(
        `SELECT status, compact, payload_bytes, receipt_invocation_id
         FROM plugin_post_deliveries WHERE delivery_id=?`
      )
      .get(row.deliveryId) as {
      status: string
      compact: number
      payload_bytes: number
      receipt_invocation_id: string
    }
    expect(stored).toMatchObject({
      status: 'delivered',
      compact: 1,
      receipt_invocation_id: 'invoke-1',
    })
    expect(stored.payload_bytes).toBeLessThanOrEqual(1_024)
    expect(
      db
        .prepare(
          `SELECT active_rows, terminal_rows FROM plugin_post_quota_ledger
           WHERE scope_key='global'`
        )
        .get()
    ).toEqual({ active_rows: 0, terminal_rows: 1 })
  })

  it('opens and durably probes the circuit breaker after retryable failure', async () => {
    const row = admission('occ-breaker', 1_000)
    repository.admitMany([row])
    const permit = (await repository.acquireBreakerPermit(
      row.executable.pluginId,
      1_000,
      'permit',
      9_000
    ))!
    const claim = (await repository.claimNextForPlugin({
      pluginId: row.executable.pluginId,
      now: 1_000,
      leaseToken: 'lease',
      leaseExpiresAt: 9_000,
      maxAttempts: 12,
      maxActiveAgeMs: 86_400_000,
    }))!

    const retried = await repository.retry(
      {
        deliveryId: claim.deliveryId,
        leaseToken: claim.leaseToken,
        nextAttemptAt: 2_000,
        errorCode: 'plugin.post.retryable',
        failedAt: 1_500,
      },
      {
        pluginId: row.executable.pluginId,
        permit,
        now: 1_500,
        threshold: 1,
        windowMs: 60_000,
        pauseMs: 60_000,
      }
    )
    expect(retried.updated).toBe(true)
    expect(retried.breaker).toMatchObject({ state: 'open', openUntil: 61_500 })
    await expect(
      repository.acquireBreakerPermit(
        row.executable.pluginId,
        61_499,
        'probe-early',
        70_000
      )
    ).resolves.toBeUndefined()
    await expect(
      repository.acquireBreakerPermit(
        row.executable.pluginId,
        61_500,
        'probe',
        70_000
      )
    ).resolves.toEqual({ mode: 'half_open', token: 'probe' })
  })

  it('terminalizes rows whose required permission is revoked without a live task', async () => {
    const row = admission('occ-revoke', 1_000, ['network'])
    repository.admitMany([row])

    await expect(
      repository.terminalizePermissionRevoked({
        pluginId: row.executable.pluginId,
        revokedPermissions: ['network'],
        at: 2_000,
      })
    ).resolves.toBe(1)
    expect(
      db
        .prepare(
          `SELECT status, permanent_reason, compact
           FROM plugin_post_deliveries WHERE delivery_id=?`
        )
        .get(row.deliveryId)
    ).toEqual({
      status: 'dead_letter',
      permanent_reason: 'permission_revoked',
      compact: 1,
    })
  })

  it('quarantines structurally malformed persisted permission arrays instead of wedging claims', async () => {
    const row = admission('occ-corrupt', 1_000)
    repository.admitMany([row])
    db.prepare(
      `UPDATE plugin_post_deliveries
       SET required_permissions_json='[1]'
       WHERE delivery_id=?`
    ).run(row.deliveryId)

    await expect(
      repository.claimNextForPlugin({
        pluginId: row.executable.pluginId,
        now: 1_000,
        leaseToken: 'lease',
        leaseExpiresAt: 2_000,
        maxAttempts: 12,
        maxActiveAgeMs: 86_400_000,
      })
    ).resolves.toBeUndefined()
    expect(
      db
        .prepare(
          `SELECT status, permanent_reason, last_error_code
           FROM plugin_post_deliveries WHERE delivery_id=?`
        )
        .get(row.deliveryId)
    ).toEqual({
      status: 'dead_letter',
      permanent_reason: 'input_invalid',
      last_error_code: 'plugin.post.persisted_input_invalid',
    })
  })

  it('reserves configured database capacity for non-post core writes', () => {
    const constrained = new SqlitePostDeliveryRepository(
      db,
      PostDeliveryQuotaConfigSchema.parse({}),
      () => 1_000,
      () => ({
        databaseCapacityBytes: POST_DELIVERY_CORE_RESERVE_BYTES + 512,
        coreLogicalBytes: 0,
      })
    )

    expect(constrained.admitMany([admission('occ-reserve', 1_000)])).toEqual({
      admitted: 0,
      deduplicated: 0,
      rejected: 1,
    })
    expect(
      db.prepare('SELECT reason FROM plugin_post_quota_buckets').get()
    ).toEqual({ reason: 'post_hard_budget' })
  })

  it('does not let an initially-invalid compact receipt consume the core reserve', () => {
    const constrained = new SqlitePostDeliveryRepository(
      db,
      PostDeliveryQuotaConfigSchema.parse({}),
      () => 1_000,
      () => ({
        databaseCapacityBytes: POST_DELIVERY_CORE_RESERVE_BYTES + 512,
        coreLogicalBytes: 0,
      })
    )
    const invalid = {
      ...admission('occ-invalid-reserve', 1_000),
      initialStatus: 'dead_letter' as const,
      initialReason: 'input_invalid' as const,
      initialErrorCode: 'plugin.hook.input_invalid',
    }

    expect(constrained.admitMany([invalid])).toEqual({
      admitted: 0,
      deduplicated: 0,
      rejected: 1,
    })
    expect(tableCount(db, 'plugin_post_deliveries')).toBe(0)
    expect(
      db.prepare('SELECT reason FROM plugin_post_quota_buckets').get()
    ).toEqual({ reason: 'post_hard_budget' })
  })

  it('prunes the oldest terminal receipt before the ledger reaches its row cap', async () => {
    repository.setQuotaConfig(
      PostDeliveryQuotaConfigSchema.parse({ pluginTerminalRows: 1 })
    )
    const first = admission('occ-terminal-first', 1_000)
    const second = admission('occ-terminal-second', 2_000)
    repository.admitMany([first, second])

    await completeDelivery(repository, first, 1_000, 1_500)
    await completeDelivery(repository, second, 2_000, 2_500)

    expect(tableCount(db, 'plugin_post_deliveries')).toBe(1)
    expect(
      db.prepare('SELECT delivery_id, status FROM plugin_post_deliveries').get()
    ).toEqual({ delivery_id: second.deliveryId, status: 'delivered' })
    expect(
      db
        .prepare(
          `SELECT terminal_rows FROM plugin_post_quota_ledger
           WHERE scope_key='global'`
        )
        .get()
    ).toEqual({ terminal_rows: 1 })
  })

  it('merges out-of-order quota rejections without moving last_at backwards', () => {
    repository.setQuotaConfig(
      PostDeliveryQuotaConfigSchema.parse({ pluginActiveRows: 1 })
    )
    repository.admitMany([admission('occ-capacity', 1_000)])
    repository.admitMany([admission('occ-newer', 3_000)])
    repository.admitMany([admission('occ-older', 2_000)])

    expect(
      db
        .prepare(
          `SELECT rejected_count, first_occurrence_id, last_occurrence_id,
                  first_at, last_at
           FROM plugin_post_quota_buckets`
        )
        .get()
    ).toEqual({
      rejected_count: 2,
      first_occurrence_id: 'occ-older',
      last_occurrence_id: 'occ-newer',
      first_at: 2_000,
      last_at: 3_000,
    })
  })
})

async function completeDelivery(
  repository: SqlitePostDeliveryRepository,
  row: ReturnType<typeof admission>,
  claimedAt: number,
  completedAt: number
): Promise<void> {
  const permit = (await repository.acquireBreakerPermit(
    row.executable.pluginId,
    claimedAt,
    `permit-${row.occurrenceId}`,
    completedAt + 10_000
  ))!
  const claim = (await repository.claimNextForPlugin({
    pluginId: row.executable.pluginId,
    now: claimedAt,
    leaseToken: `lease-${row.occurrenceId}`,
    leaseExpiresAt: completedAt + 10_000,
    maxAttempts: 12,
    maxActiveAgeMs: 86_400_000,
  }))!
  await repository.complete(
    {
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      receipt: {
        deliveryId: claim.deliveryId,
        invocationId: `invoke-${row.occurrenceId}`,
        completedAt,
      },
    },
    { pluginId: row.executable.pluginId, permit, now: completedAt }
  )
}

function admission(
  occurrenceId: string,
  at: number,
  permissions: readonly string[] = []
) {
  return materializePostDeliveries({
    event: {
      schemaVersion: 1,
      occurrenceId,
      taskId: `task-${occurrenceId}`,
      occurredAt: at,
      payload: {
        filePath: `/downloads/${occurrenceId}.bin`,
        task: {
          schemaVersion: 1,
          id: `task-${occurrenceId}`,
          name: `${occurrenceId}.bin`,
          type: 'http',
          kind: 'direct',
          status: 'completed',
          filePath: `/downloads/${occurrenceId}.bin`,
          saveDir: '/downloads',
          filename: `${occurrenceId}.bin`,
          progress: 100,
          totalBytes: 1,
          downloadedBytes: 1,
          uploadedBytes: 0,
          sizeWhenDone: 1,
          fileCount: 1,
          createdAt: at,
          updatedAt: at,
          finishedAt: at,
          category: null,
          infoHash: null,
          error: null,
        },
      },
    },
    candidates: [
      {
        hook: 'afterComplete',
        executable: {
          pluginId: 'plugin.example',
          version: '1.0.0',
          digest: 'a'.repeat(64),
        },
        createdGeneration: 1,
        requiredPermissions: permissions,
        createdEffectivePermissions: permissions,
      },
    ],
    createdAt: at,
  })[0]
}

function tableCount(db: Database.Database, table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number
    }
  ).count
}
