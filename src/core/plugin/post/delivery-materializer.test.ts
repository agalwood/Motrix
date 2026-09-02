import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  materializePostDeliveries,
} from './delivery-materializer'
import type {
  JsonValue,
  PostDeliveryCandidateSnapshot,
  PostDeliveryEventSnapshot,
} from './delivery-types'

const CANDIDATE: PostDeliveryCandidateSnapshot = {
  hook: 'afterComplete',
  executable: {
    pluginId: 'example.plugin',
    version: '1.2.3',
    digest: 'a'.repeat(64),
  },
  createdGeneration: 7,
  requiredPermissions: ['metadata'],
  createdEffectivePermissions: ['notify', 'metadata', 'metadata'],
}

function event(payload: JsonValue): PostDeliveryEventSnapshot {
  return {
    schemaVersion: 1,
    occurrenceId: 'occ-1',
    taskId: 'task-1',
    occurredAt: 1_000,
    payload,
  }
}

function validPayload(reverseTaskKeys = false): JsonValue {
  const task = reverseTaskKeys
    ? {
        error: null,
        infoHash: null,
        category: null,
        finishedAt: 999,
        updatedAt: 999,
        createdAt: 1,
        fileCount: 1,
        sizeWhenDone: 10,
        uploadedBytes: 0,
        downloadedBytes: 10,
        totalBytes: 10,
        progress: 100,
        filename: 'a.bin',
        saveDir: '/downloads',
        filePath: '/downloads/a.bin',
        status: 'completed',
        kind: 'direct',
        type: 'http',
        name: 'a',
        id: 'task-1',
        schemaVersion: 1,
      }
    : {
        schemaVersion: 1,
        id: 'task-1',
        name: 'a',
        type: 'http',
        kind: 'direct',
        status: 'completed',
        filePath: '/downloads/a.bin',
        saveDir: '/downloads',
        filename: 'a.bin',
        progress: 100,
        totalBytes: 10,
        downloadedBytes: 10,
        uploadedBytes: 0,
        sizeWhenDone: 10,
        fileCount: 1,
        createdAt: 1,
        updatedAt: 999,
        finishedAt: 999,
        category: null,
        infoHash: null,
        error: null,
      }
  return reverseTaskKeys
    ? { filePath: '/downloads/a.bin', task }
    : { task, filePath: '/downloads/a.bin' }
}

describe('canonicalJson', () => {
  it('sorts every object level while preserving array order', () => {
    expect(
      canonicalJson({ z: 1, a: { y: 2, x: 1 }, list: [{ b: 2, a: 1 }] })
    ).toBe('{"a":{"x":1,"y":2},"list":[{"a":1,"b":2}],"z":1}')
  })

  it('rejects non-JSON numbers and cycles', () => {
    expect(() => canonicalJson(Number.NaN as unknown as JsonValue)).toThrow(
      'non-finite'
    )
    const cyclic: Record<string, JsonValue> = {}
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow('cyclic')
  })
})

describe('materializePostDeliveries', () => {
  it('creates a stable identity and byte-identical self-contained payload', () => {
    const first = materializePostDeliveries({
      event: event(validPayload()),
      candidates: [CANDIDATE],
      createdAt: 1_001,
    })[0]
    const reordered = materializePostDeliveries({
      event: event(validPayload(true)),
      candidates: [
        {
          ...CANDIDATE,
          requiredPermissions: ['metadata'],
          createdEffectivePermissions: ['metadata', 'notify'],
        },
      ],
      createdAt: 1_001,
    })[0]

    expect(first.deliveryId).toBe(reordered.deliveryId)
    expect(first.canonicalPayload).toBe(reordered.canonicalPayload)
    expect(first.canonicalPayload).toContain(`"id":"${first.deliveryId}"`)
    expect(first.createdEffectivePermissions).toEqual(['metadata', 'notify'])
    expect(first.reservedBytes).toBe(
      first.payloadBytes + first.permissionSnapshotBytes + 512
    )
    expect(first.canonicalPayload).not.toContain('task-store')
  })

  it('uses executable identity and Hook in the stable deduplication key', () => {
    const rows = materializePostDeliveries({
      event: event(validPayload()),
      candidates: [
        CANDIDATE,
        {
          ...CANDIDATE,
          hook: 'onError',
        },
        {
          ...CANDIDATE,
          executable: { ...CANDIDATE.executable, version: '2.0.0' },
        },
      ],
      createdAt: 1_001,
    })
    expect(new Set(rows.map((row) => row.deliveryId))).toHaveLength(3)
  })

  it('materializes invalid permission snapshots as observable dead letters', () => {
    const row = materializePostDeliveries({
      event: event(validPayload()),
      candidates: [
        {
          ...CANDIDATE,
          requiredPermissions: ['metadata', 'notify'],
          createdEffectivePermissions: ['metadata'],
        },
      ],
      createdAt: 1_001,
    })[0]
    expect(row).toMatchObject({
      initialStatus: 'dead_letter',
      initialReason: 'input_invalid',
      initialErrorCode: 'plugin.hook.input_invalid',
    })
  })

  it('runtime-validates the self-contained post context before admission', () => {
    const payload = validPayload() as {
      task: { id: string }
      filePath: string
    }
    payload.task.id = 'another-task'
    const row = materializePostDeliveries({
      event: event(payload as JsonValue),
      candidates: [CANDIDATE],
      createdAt: 1_001,
    })[0]
    expect(row).toMatchObject({
      initialStatus: 'dead_letter',
      initialReason: 'input_invalid',
    })
  })

  it('rejects and strips invocation-owned fields from the stable payload', () => {
    const payload = validPayload() as Record<string, JsonValue>
    payload.invocationId = 'stale-invocation'
    payload.delivery = {
      schemaVersion: 1,
      id: 'guest-controlled',
      occurrenceId: 'guest-controlled',
      occurredAt: 0,
    }
    const row = materializePostDeliveries({
      event: event(payload),
      candidates: [CANDIDATE],
      createdAt: 1_001,
    })[0]
    expect(row.initialStatus).toBe('dead_letter')
    expect(row.canonicalPayload).not.toContain('stale-invocation')
    expect(row.canonicalPayload).not.toContain('guest-controlled')
    expect(row.canonicalPayload).toContain(row.deliveryId)
  })

  it('stores a bounded permanent row for a malformed candidate identity', () => {
    const row = materializePostDeliveries({
      event: event(validPayload()),
      candidates: [
        {
          ...CANDIDATE,
          executable: { ...CANDIDATE.executable, pluginId: '' },
        },
      ],
      createdAt: 1_001,
    })[0]
    expect(row).toMatchObject({
      initialStatus: 'dead_letter',
      initialReason: 'input_invalid',
    })
    expect(row.executable.pluginId).toMatch(/^invalid-candidate\.[0-9a-f]{32}$/)
  })
})
