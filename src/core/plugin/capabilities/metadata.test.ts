import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ensureMetadataSchema,
  MetadataCapabilityHost,
  MetadataError,
} from './metadata'

function makeHost(perPluginPerTaskBytes?: number) {
  const db = new Database(':memory:')
  ensureMetadataSchema(db)
  return {
    db,
    host: new MetadataCapabilityHost({ db, perPluginPerTaskBytes }),
  }
}

describe('MetadataCapabilityHost', () => {
  let host: MetadataCapabilityHost

  beforeEach(() => {
    ;({ host } = makeHost())
  })

  // Test 1: get returns undefined for missing key
  it('get returns undefined for missing key', async () => {
    const result = await host.get('task-1', 'plugin-a', 'missing')
    expect(result).toBeUndefined()
  })

  // Test 2: has returns false for missing, true after set
  it('has returns false for missing key, true after set', async () => {
    expect(await host.has('task-1', 'plugin-a', 'k')).toBe(false)
    await host.set('task-1', 'plugin-a', 'k', 'v')
    expect(await host.has('task-1', 'plugin-a', 'k')).toBe(true)
  })

  // Test 3: set then get round-trips
  it('set then get round-trips value', async () => {
    await host.set('task-1', 'plugin-a', 'myKey', { foo: 42 })
    const result = await host.get('task-1', 'plugin-a', 'myKey')
    expect(result).toEqual({ foo: 42 })
  })

  // Test 4: getAll returns all key→value entries for (task, plugin)
  it('getAll returns all entries for (task, plugin)', async () => {
    await host.set('task-1', 'plugin-a', 'alpha', 1)
    await host.set('task-1', 'plugin-a', 'beta', 2)
    const all = await host.getAll('task-1', 'plugin-a')
    expect(all).toEqual({ alpha: 1, beta: 2 })
  })

  // Test 4b: getAll returns empty object when no entries
  it('getAll returns {} when no entries exist', async () => {
    const all = await host.getAll('task-1', 'plugin-a')
    expect(all).toEqual({})
  })

  // Test 5: keys returns sorted list
  it('keys returns sorted list of keys', async () => {
    await host.set('task-1', 'plugin-a', 'zebra', 1)
    await host.set('task-1', 'plugin-a', 'apple', 2)
    await host.set('task-1', 'plugin-a', 'mango', 3)
    const result = await host.keys('task-1', 'plugin-a')
    expect(result).toEqual(['apple', 'mango', 'zebra'])
  })

  // Test 6: cross-plugin isolation
  it('cross-plugin isolation: pluginA getAll does not include pluginB keys', async () => {
    const { host: h } = makeHost()
    await h.set('task-1', 'plugin-a', 'a', 1)
    await h.set('task-1', 'plugin-b', 'b', 2)

    const allA = await h.getAll('task-1', 'plugin-a')
    expect(allA).toEqual({ a: 1 })

    const allB = await h.getAll('task-1', 'plugin-b')
    expect(allB).toEqual({ b: 2 })
  })

  // Test 7: cross-task isolation
  it('cross-task isolation: same plugin, different tasks are independent', async () => {
    await host.set('t1', 'plugin-a', 'k', 1)
    await host.set('t2', 'plugin-a', 'k', 2)

    expect(await host.get('t1', 'plugin-a', 'k')).toBe(1)
    expect(await host.get('t2', 'plugin-a', 'k')).toBe(2)
  })

  // Test 8: delete returns correct boolean
  it('delete returns {deleted: true} for existing key, {deleted: false} for missing', async () => {
    await host.set('task-1', 'plugin-a', 'k', 'v')

    const r1 = await host.delete('task-1', 'plugin-a', 'k')
    expect(r1).toEqual({ deleted: true })

    const r2 = await host.delete('task-1', 'plugin-a', 'k')
    expect(r2).toEqual({ deleted: false })
  })

  // Test 9: deleteAllForTask removes all rows for task across plugins
  it('deleteAllForTask removes all entries for task across plugins and returns count', async () => {
    await host.set('t1', 'plugin-a', 'k1', 1)
    await host.set('t1', 'plugin-b', 'k2', 2)
    await host.set('t2', 'plugin-a', 'k3', 3) // different task, must survive

    const result = await host.deleteAllForTask('t1')
    expect(result).toEqual({ deleted: 2 })

    expect(await host.getAll('t1', 'plugin-a')).toEqual({})
    expect(await host.getAll('t1', 'plugin-b')).toEqual({})
    expect(await host.get('t2', 'plugin-a', 'k3')).toBe(3)
  })

  // Test 9b: deleteAllForPlugin uninstall cascade — I14 invariant
  it('deleteAllForPlugin removes rows across all tasks for one plugin only', async () => {
    await host.set('t1', 'plugin-a', 'k1', 1)
    await host.set('t2', 'plugin-a', 'k2', 2)
    await host.set('t1', 'plugin-b', 'k3', 3) // sibling plugin, must survive

    const result = await host.deleteAllForPlugin('plugin-a')
    expect(result).toEqual({ deleted: 2 })

    expect(await host.getAll('t1', 'plugin-a')).toEqual({})
    expect(await host.getAll('t2', 'plugin-a')).toEqual({})
    expect(await host.get('t1', 'plugin-b', 'k3')).toBe(3)
  })

  it('deleteAllForPlugin on an unknown plugin returns deleted: 0', async () => {
    const result = await host.deleteAllForPlugin('plugin-unknown')
    expect(result).toEqual({ deleted: 0 })
  })

  // Test 10a: quota: large value rejected
  it('quota exceeded throws plugin.metadata.quota_exceeded', async () => {
    const { host: h } = makeHost(128)
    // 200-char string will exceed 128 byte quota
    const bigValue = 'x'.repeat(200)

    await expect(
      h.set('task-1', 'plugin-a', 'big', bigValue)
    ).rejects.toMatchObject({ code: 'plugin.metadata.quota_exceeded' })
  })

  // Test 10b: quota: updating same key respects delta (no double-counting)
  it('quota update respects size delta — replacing same key stays under quota', async () => {
    const { host: h } = makeHost(128)
    // First value: 100 bytes (the JSON string "xxx...x" with 100 x's is 102 bytes incl. quotes)
    const small = 'x'.repeat(90) // ~92 bytes JSON
    await h.set('task-1', 'plugin-a', 'k', small)

    // Updating to a value of similar size should not double-count
    const similar = 'y'.repeat(90)
    await expect(
      h.set('task-1', 'plugin-a', 'k', similar)
    ).resolves.toBeUndefined()
  })

  // Test 10c: quota: upsert to larger value that exceeds quota is rejected
  it('quota: upsert to a larger value that exceeds quota is rejected', async () => {
    const { host: h } = makeHost(128)
    const small = 'x'.repeat(10)
    await h.set('task-1', 'plugin-a', 'k', small)

    // Now try to replace with something that pushes over quota
    const big = 'y'.repeat(200)
    await expect(h.set('task-1', 'plugin-a', 'k', big)).rejects.toMatchObject({
      code: 'plugin.metadata.quota_exceeded',
    })
  })

  // Test 11a: BigInt is not serializable
  it('BigInt throws plugin.metadata.value_not_serializable', async () => {
    await expect(host.set('task-1', 'plugin-a', 'k', 1n)).rejects.toMatchObject(
      { code: 'plugin.metadata.value_not_serializable' }
    )
  })

  // Test 11b: class with throwing toJSON is not serializable
  it('class with throwing toJSON throws plugin.metadata.value_not_serializable', async () => {
    class Bad {
      toJSON() {
        throw new Error('cannot serialize')
      }
    }

    await expect(
      host.set('task-1', 'plugin-a', 'k', new Bad())
    ).rejects.toMatchObject({ code: 'plugin.metadata.value_not_serializable' })
  })

  // Test 11c: top-level undefined is not serializable
  it('top-level undefined throws plugin.metadata.value_not_serializable', async () => {
    await expect(
      host.set('task-1', 'plugin-a', 'k', undefined)
    ).rejects.toMatchObject({ code: 'plugin.metadata.value_not_serializable' })
  })

  // Test: MetadataError has correct name and code
  it('MetadataError has name MetadataError and exposes code', () => {
    const err = new MetadataError('plugin.metadata.quota_exceeded', 'msg')
    expect(err.name).toBe('MetadataError')
    expect(err.code).toBe('plugin.metadata.quota_exceeded')
    expect(err).toBeInstanceOf(Error)
  })
})
