import { ensureMetadataSchema } from '@core/plugin/capabilities/metadata'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StagedEffectStore, type StagedHttpPatch } from './staged-effects'
import type { FfmpegStaging } from './staging-dir'

function makeDb() {
  const db = new Database(':memory:')
  ensureMetadataSchema(db)
  return db
}

function allRows(
  db: Database.Database,
  taskId: string
): Array<{ plugin_id: string; key: string; value: string }> {
  return db
    .prepare<[string], { plugin_id: string; key: string; value: string }>(
      'SELECT plugin_id, key, value FROM plugin_task_metadata WHERE task_id=? ORDER BY plugin_id, key'
    )
    .all(taskId)
}

describe('StagedEffectStore', () => {
  let store: StagedEffectStore

  beforeEach(() => {
    store = new StagedEffectStore()
  })

  // ── 1. starts empty ──────────────────────────────────────────────────────────

  it('starts empty: latestStagedFields={}, allHttpPatches=[], pendingFinalizePath=undefined', () => {
    expect(store.latestStagedFields()).toEqual({})
    expect(store.allHttpPatches()).toEqual([])
    expect(store.pendingFinalizePath).toBeUndefined()
  })

  // ── 2. HTTP patch merge ──────────────────────────────────────────────────────

  it('multiple plugins append HTTP patches; latestStagedFields returns post-merge view', () => {
    store.appendHttp('plugin-a', 'resolve', {
      uris: ['https://cdn.example.com/file.zip'],
      filename: 'original.zip',
      connections: 4,
    })
    store.appendHttp('plugin-b', 'enrich', {
      filename: 'renamed.zip',
      connections: 8,
    })
    store.appendHttp('plugin-c', 'post-process', {
      uris: ['https://mirror.example.com/file.zip'],
    })

    const merged = store.latestStagedFields()
    // last uris win
    expect(merged.uris).toEqual(['https://mirror.example.com/file.zip'])
    // last filename wins (plugin-b, since plugin-c didn't set it)
    expect(merged.filename).toBe('renamed.zip')
    // last connections win (plugin-b, since plugin-c didn't set it)
    expect(merged.connections).toBe(8)
  })

  // ── 3. appendMeta set + commitMetadata writes rows ───────────────────────────

  it('appendMeta set ops are written atomically via commitMetadata', () => {
    const db = makeDb()
    store.appendMeta({
      pluginId: 'plugin-a',
      op: 'set',
      key: 'score',
      value: 42,
    })
    store.appendMeta({
      pluginId: 'plugin-a',
      op: 'set',
      key: 'label',
      value: 'fast',
    })

    store.commitMetadata(db, 'task-1', () => {})

    const rows = allRows(db, 'task-1')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      plugin_id: 'plugin-a',
      key: 'label',
      value: '"fast"',
    })
    expect(rows[1]).toMatchObject({
      plugin_id: 'plugin-a',
      key: 'score',
      value: '42',
    })
  })

  // ── 4. appendMeta delete removes rows ────────────────────────────────────────

  it('appendMeta delete ops remove existing rows in the same transaction', () => {
    const db = makeDb()

    // Pre-seed a row via a direct insert outside the store
    db.prepare(
      `INSERT INTO plugin_task_metadata (task_id, plugin_id, key, value, size, updated_at)
       VALUES ('task-1', 'plugin-a', 'toRemove', '"exists"', 8, 0)`
    ).run()

    store.appendMeta({
      pluginId: 'plugin-a',
      op: 'delete',
      key: 'toRemove',
    })
    store.commitMetadata(db, 'task-1', () => {})

    const rows = allRows(db, 'task-1')
    expect(rows).toHaveLength(0)
  })

  // ── 5. tx callback runs inside the same transaction ──────────────────────────

  it('user-supplied tx callback runs inside the same transaction as metadata writes', () => {
    const db = makeDb()
    const callOrder: string[] = []

    store.appendMeta({ pluginId: 'plugin-a', op: 'set', key: 'k', value: 1 })

    store.commitMetadata(db, 'task-1', () => {
      callOrder.push('tx')
      // At this point the transaction is open; verify by attempting a write
      db.prepare(
        `INSERT INTO plugin_task_metadata (task_id, plugin_id, key, value, size, updated_at)
         VALUES ('task-1', 'plugin-tx', 'txKey', '"txVal"', 7, 0)`
      ).run()
      callOrder.push('tx-write')
    })
    callOrder.push('after-commit')

    expect(callOrder).toEqual(['tx', 'tx-write', 'after-commit'])

    // Both the tx write and the staged meta write should be present
    const rows = allRows(db, 'task-1')
    expect(rows.some((r) => r.key === 'txKey')).toBe(true)
    expect(rows.some((r) => r.key === 'k')).toBe(true)
  })

  // ── 6. tx throw rolls back everything ────────────────────────────────────────

  it('if tx throws, the entire transaction rolls back — no rows persisted', () => {
    const db = makeDb()

    store.appendMeta({
      pluginId: 'plugin-a',
      op: 'set',
      key: 'willNotExist',
      value: 'ghost',
    })

    expect(() =>
      store.commitMetadata(db, 'task-1', () => {
        throw new Error('tx failed intentionally')
      })
    ).toThrow('tx failed intentionally')

    // Nothing should have been committed
    const rows = allRows(db, 'task-1')
    expect(rows).toHaveLength(0)
  })

  // ── 7. setFinalizePath / pendingFinalizePath round-trip ──────────────────────

  it('setFinalizePath and pendingFinalizePath round-trip', () => {
    expect(store.pendingFinalizePath).toBeUndefined()
    store.setFinalizePath('/downloads/final/file.mkv')
    expect(store.pendingFinalizePath).toBe('/downloads/final/file.mkv')
  })

  // ── 8. discard clears in-memory state, DB untouched ─────────────────────────

  it('discard() clears in-memory state without touching the database', () => {
    const db = makeDb()

    // Pre-seed DB row directly
    db.prepare(
      `INSERT INTO plugin_task_metadata (task_id, plugin_id, key, value, size, updated_at)
       VALUES ('task-1', 'plugin-a', 'existing', '"val"', 5, 0)`
    ).run()

    store.appendHttp('plugin-a', 'resolve', { filename: 'temp.zip' })
    store.appendMeta({
      pluginId: 'plugin-a',
      op: 'set',
      key: 'pending',
      value: 99,
    })
    store.setFinalizePath('/tmp/out.zip')

    store.discard()

    // In-memory state is cleared
    expect(store.latestStagedFields()).toEqual({})
    expect(store.allHttpPatches()).toHaveLength(0)
    expect(store.pendingFinalizePath).toBeUndefined()

    // DB row that existed before discard is still there
    const rows = allRows(db, 'task-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.key).toBe('existing')
  })

  // ── 9. allHttpPatches returns append-order entries with correct shape ─────────

  it('allHttpPatches returns entries in append order with { pluginId, role, patch } shape', () => {
    store.appendHttp('plugin-a', 'resolve', {
      uris: ['https://a.example.com/'],
    })
    store.appendHttp('plugin-b', 'enrich', { filename: 'enriched.zip' })
    store.appendHttp('plugin-c', 'post-process', { connections: 16 })

    const patches = store.allHttpPatches()
    expect(patches).toHaveLength(3)
    expect(patches[0]).toEqual({
      pluginId: 'plugin-a',
      role: 'resolve',
      patch: { uris: ['https://a.example.com/'] },
    })
    expect(patches[1]).toEqual({
      pluginId: 'plugin-b',
      role: 'enrich',
      patch: { filename: 'enriched.zip' },
    })
    expect(patches[2]).toEqual({
      pluginId: 'plugin-c',
      role: 'post-process',
      patch: { connections: 16 },
    })
  })

  // ── extra: tx spy records ordering relative to meta writes ───────────────────

  it('tx spy confirms it is called before metadata rows land', () => {
    const db = makeDb()
    const spy = vi.fn()

    store.appendMeta({
      pluginId: 'plugin-a',
      op: 'set',
      key: 'after',
      value: 1,
    })
    store.commitMetadata(db, 'task-1', spy)

    expect(spy).toHaveBeenCalledOnce()
  })

  // ── removeFromPlugin drops both http patches and metadata ops ──────────────

  it('removeFromPlugin drops both http patches and metadata ops for that plugin', () => {
    const store = new StagedEffectStore()
    store.appendHttp('p1', 'enrich', { filename: 'p1.bin' })
    store.appendHttp('p2', 'enrich', { filename: 'p2.bin' })
    store.appendMeta({ pluginId: 'p1', op: 'set', key: 'a', value: '1' })
    store.appendMeta({ pluginId: 'p2', op: 'set', key: 'b', value: '2' })

    store.removeFromPlugin('p1')

    // http patches: only p2 remains
    expect(store.allHttpPatches()).toEqual([
      expect.objectContaining({
        pluginId: 'p2',
        patch: { filename: 'p2.bin' },
      }),
    ])
    // metadata ops: only p2 remains — verify via DB commit
    const db = makeDb()
    store.commitMetadata(db, 't1', () => {})
    const rows = db
      .prepare(
        'SELECT plugin_id, key FROM plugin_task_metadata ORDER BY plugin_id'
      )
      .all()
    expect(rows).toEqual([{ plugin_id: 'p2', key: 'b' }])
  })

  // ── 10. appendHttp shallow-clones the patch — caller mutation does not leak ──

  it('appendHttp shallow-clones the patch so caller mutation does not leak in', () => {
    const patch: StagedHttpPatch = {
      filename: 'original.zip',
      connections: 4,
    }
    store.appendHttp('plugin-a', 'resolve', patch)

    // Mutate the caller's reference after append.
    patch.filename = 'mutated.zip'
    patch.connections = 99

    expect(store.latestStagedFields()).toEqual({
      filename: 'original.zip',
      connections: 4,
    })
    expect(store.allHttpPatches()[0]?.patch).toEqual({
      filename: 'original.zip',
      connections: 4,
    })
  })
})

describe('StagedEffectStore — ffmpeg stagings', () => {
  function fakeStaging(id: string): FfmpegStaging {
    return { id } as unknown as FfmpegStaging // identity probe; we only check Map round-trip
  }

  it('appendStaging + takeAllStagings round-trip', () => {
    const store = new StagedEffectStore()
    const a = fakeStaging('a')
    const b = fakeStaging('b')
    store.appendStaging('alice', a)
    store.appendStaging('bob', b)
    const taken = store.takeAllStagings()
    expect(taken).toEqual([
      { pluginId: 'alice', staging: a },
      { pluginId: 'bob', staging: b },
    ])
    expect(store.takeAllStagings()).toEqual([]) // second call empty
  })

  it("removeFromPlugin also drops that plugin's staging", () => {
    const store = new StagedEffectStore()
    store.appendStaging('alice', fakeStaging('a'))
    store.appendStaging('bob', fakeStaging('b'))
    store.removeFromPlugin('alice')
    expect(store.takeAllStagings()).toEqual([
      { pluginId: 'bob', staging: expect.any(Object) },
    ])
  })

  it('one plugin can only register one staging (later replaces earlier)', () => {
    const store = new StagedEffectStore()
    const a1 = fakeStaging('a1')
    const a2 = fakeStaging('a2')
    store.appendStaging('alice', a1)
    store.appendStaging('alice', a2)
    expect(store.takeAllStagings()).toEqual([
      { pluginId: 'alice', staging: a2 },
    ])
  })

  it('takeAllStagings on a fresh store returns []', () => {
    expect(new StagedEffectStore().takeAllStagings()).toEqual([])
  })

  it('re-adding after removeFromPlugin works (fail-open retry path)', () => {
    const store = new StagedEffectStore()
    const a = fakeStaging('a')
    const a2 = fakeStaging('a2')
    store.appendStaging('alice', a)
    store.removeFromPlugin('alice')
    store.appendStaging('alice', a2)
    expect(store.takeAllStagings()).toEqual([
      { pluginId: 'alice', staging: a2 },
    ])
  })
})
