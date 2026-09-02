import { describe, expect, it, vi } from 'vitest'
import type { PostDeliveryRetentionRepository } from './delivery-retention'
import {
  admitPostDeliveries,
  compactTerminalReceipt,
  evaluatePostDeliveryAdmission,
  PostDeliveryRetention,
  quotaTombstoneUtcDay,
} from './delivery-retention'
import type { PostDeliveryAdmission } from './delivery-types'

function admission(deliveryId: string): PostDeliveryAdmission {
  return {
    deliveryId,
    deduplicationKey: 'a'.repeat(64),
    hook: 'afterComplete',
    executable: {
      pluginId: 'plugin-a',
      version: '1.0.0',
      digest: 'b'.repeat(64),
    },
    createdGeneration: 1,
    requiredPermissions: [],
    createdEffectivePermissions: [],
    occurrenceId: `occ-${deliveryId}`,
    taskId: 'task-a',
    occurredAt: 1,
    canonicalPayload: '{}',
    payloadBytes: 2,
    permissionSnapshotBytes: 4,
    reservedBytes: 518,
    createdAt: 1,
    initialStatus: 'pending',
  }
}

describe('evaluatePostDeliveryAdmission', () => {
  const baseUsage = {
    pluginActiveRows: 0,
    pluginActiveBytes: 0,
    globalActiveRows: 0,
    globalActiveBytes: 0,
    postLogicalBytes: 0,
    databaseCapacityBytes: 2 * 1024 * 1024 * 1024,
    coreLogicalBytes: 0,
  }

  it('admits only when plugin, global, hard, and reserve budgets all fit', () => {
    expect(
      evaluatePostDeliveryAdmission({ reservedBytes: 1_024 }, baseUsage)
    ).toEqual({ admitted: true })
    expect(
      evaluatePostDeliveryAdmission(
        { reservedBytes: 1_024 },
        { ...baseUsage, pluginActiveRows: 1_000 }
      )
    ).toEqual({ admitted: false, reason: 'plugin_active_rows' })
    expect(
      evaluatePostDeliveryAdmission(
        { reservedBytes: 1_024 },
        {
          ...baseUsage,
          databaseCapacityBytes: 128 * 1024 * 1024 + 1_023,
        }
      )
    ).toEqual({ admitted: false, reason: 'post_hard_budget' })
  })

  it('calculates UTC tombstone buckets deterministically', () => {
    expect(quotaTombstoneUtcDay(Date.UTC(2026, 7, 31, 23, 59))).toBe(
      '2026-08-31'
    )
  })

  it('keeps admission and bounded tombstone writes inside the caller transaction', () => {
    const calls: string[] = []
    const summary = admitPostDeliveries(
      {
        admitOrTombstone: (row) => {
          calls.push(row.deliveryId)
          return row.deliveryId === 'accepted'
            ? { kind: 'admitted', deliveryId: row.deliveryId }
            : {
                kind: 'rejected',
                deliveryId: row.deliveryId,
                reason: 'plugin_active_rows',
                tombstoneKey: 'plugin:afterComplete:rows:2026-08-31',
              }
        },
      },
      [admission('accepted'), admission('rejected')]
    )
    expect(calls).toEqual(['accepted', 'rejected'])
    expect(summary).toMatchObject({ admitted: 1, duplicates: 0, rejected: 1 })
  })
})

describe('compactTerminalReceipt', () => {
  it('keeps only bounded terminal outcome fields', () => {
    const compact = compactTerminalReceipt({
      deliveryId: 'delivery-1',
      pluginId: 'plugin-a',
      hook: 'afterComplete',
      status: 'dead_letter',
      completedAt: 10,
      attemptCount: 12,
      reason: 'attempt_limit',
    })
    expect(Buffer.byteLength(compact, 'utf8')).toBeLessThanOrEqual(1_024)
    expect(JSON.parse(compact)).toEqual({
      attemptCount: 12,
      completedAt: 10,
      deliveryId: 'delivery-1',
      hook: 'afterComplete',
      pluginId: 'plugin-a',
      reason: 'attempt_limit',
      status: 'dead_letter',
    })
  })
})

describe('PostDeliveryRetention', () => {
  it('uses exact lifecycle outcomes and emits aggregate observability', async () => {
    const repository: PostDeliveryRetentionRepository = {
      reconcileLedger: vi.fn().mockResolvedValue({
        activeRows: 0,
        activeBytes: 0,
        terminalRows: 0,
        terminalBytes: 0,
        tombstoneRows: 0,
        tombstoneBytes: 0,
      }),
      compactTerminalOverQuota: vi.fn().mockResolvedValue(2),
      pruneTerminalReceipts: vi.fn().mockResolvedValue(3),
      terminalizeExecutable: vi.fn().mockResolvedValue(4),
      terminalizePlugin: vi.fn().mockResolvedValue(5),
      terminalizePermissionRevoked: vi.fn().mockResolvedValue(6),
    }
    const emit = vi.fn()
    const retention = new PostDeliveryRetention({
      repository,
      observability: { emit },
    })

    await expect(
      retention.supersede(
        { pluginId: 'a', version: '1.0.0', digest: 'a'.repeat(64) },
        100
      )
    ).resolves.toBe(4)
    await expect(
      retention.pluginUnavailable('b', 'quarantined', 101)
    ).resolves.toBe(5)
    await expect(
      retention.permissionRevoked('c', ['notify', 'http', 'notify'], 102)
    ).resolves.toBe(6)
    await expect(
      retention.maintain(31 * 24 * 60 * 60_000, 30 * 24 * 60 * 60_000)
    ).resolves.toEqual({
      compacted: 2,
      pruned: 3,
    })

    expect(repository.terminalizePermissionRevoked).toHaveBeenCalledWith({
      pluginId: 'c',
      revokedPermissions: ['http', 'notify'],
      at: 102,
    })
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plugin.post.lifecycle_terminal',
        pluginId: 'a',
        reason: 'superseded',
        affectedRows: 4,
      })
    )
  })

  it('reports repository faults as system storage errors without relabeling them', async () => {
    const storageError = new Error('disk full')
    const emit = vi.fn()
    const retention = new PostDeliveryRetention({
      repository: {
        reconcileLedger: vi.fn().mockRejectedValue(storageError),
        compactTerminalOverQuota: vi.fn(),
        pruneTerminalReceipts: vi.fn(),
        terminalizeExecutable: vi.fn(),
        terminalizePlugin: vi.fn(),
        terminalizePermissionRevoked: vi.fn(),
      },
      clock: { now: () => 77 },
      observability: { emit },
    })
    await expect(retention.reconcile()).rejects.toBe(storageError)
    expect(emit).toHaveBeenCalledWith({
      type: 'plugin.post.storage_error',
      at: 77,
      operation: 'reconcileLedger',
      errorCode: 'plugin.post.storage_error',
    })
  })
})
