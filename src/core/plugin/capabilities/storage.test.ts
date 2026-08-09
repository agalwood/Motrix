import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { ensureStorageSchema, StorageCapabilityHost } from './storage'

function makeHost(quotaBytes = 256) {
  const db = new Database(':memory:')
  ensureStorageSchema(db)
  return { db, host: new StorageCapabilityHost({ db, quotaBytes }) }
}

describe('StorageCapabilityHost', () => {
  let host: StorageCapabilityHost

  beforeEach(() => {
    ;({ host } = makeHost())
  })

  // Test 1: get returns sentinel for missing key
  it('get returns {value: undefined, version: 0} for missing key', async () => {
    const result = await host.get('plugin-a', 'missing')
    expect(result).toEqual({ value: undefined, version: 0 })
  })

  // Test 2: set creates with version 1; subsequent set increments to 2
  it('set creates with version 1 and increments to 2 on second set', async () => {
    const r1 = await host.set('plugin-a', 'k', 'hello')
    expect(r1.version).toBe(1)

    const r2 = await host.set('plugin-a', 'k', 'world')
    expect(r2.version).toBe(2)

    const got = await host.get('plugin-a', 'k')
    expect(got).toEqual({ value: 'world', version: 2 })
  })

  // Test 3: compareAndSet succeeds when version matches
  it('compareAndSet(pid, k, 1, v2) succeeds when version matches', async () => {
    await host.set('plugin-a', 'k', 'v1')
    const r = await host.compareAndSet('plugin-a', 'k', 1, 'v2')
    expect(r.version).toBe(2)

    const got = await host.get('plugin-a', 'k')
    expect(got).toEqual({ value: 'v2', version: 2 })
  })

  // Test 4: stale compareAndSet throws cas_mismatch
  it('stale compareAndSet(pid, k, 1, v2) after version=2 throws cas_mismatch', async () => {
    await host.set('plugin-a', 'k', 'v1')
    await host.compareAndSet('plugin-a', 'k', 1, 'v2') // now version=2

    await expect(
      host.compareAndSet('plugin-a', 'k', 1, 'v3')
    ).rejects.toMatchObject({ code: 'plugin.storage.cas_mismatch' })
  })

  // Test 5a: compareAndSet(0) inserts if absent
  it('compareAndSet(pid, k, 0, v) inserts if absent', async () => {
    const r = await host.compareAndSet('plugin-a', 'new-key', 0, 'inserted')
    expect(r.version).toBe(1)

    const got = await host.get('plugin-a', 'new-key')
    expect(got).toEqual({ value: 'inserted', version: 1 })
  })

  // Test 5b: compareAndSet(0) throws cas_mismatch if present
  it('compareAndSet(pid, k, 0, v) throws cas_mismatch if key already exists', async () => {
    await host.set('plugin-a', 'k', 'existing')

    await expect(
      host.compareAndSet('plugin-a', 'k', 0, 'conflict')
    ).rejects.toMatchObject({ code: 'plugin.storage.cas_mismatch' })
  })

  // Test 6: keys with prefix filter scoped to plugin
  it('keys(pid, prefix) returns matching keys only, scoped to plugin', async () => {
    await host.set('plugin-a', 'foo.alpha', 1)
    await host.set('plugin-a', 'foo.beta', 2)
    await host.set('plugin-a', 'bar.gamma', 3)
    await host.set('plugin-b', 'foo.delta', 4) // different plugin

    const result = await host.keys('plugin-a', 'foo.')
    expect(result.sort()).toEqual(['foo.alpha', 'foo.beta'])
  })

  // Test 7: quota enforced
  it('quota exceeded throws plugin.storage.quota_exceeded', async () => {
    // quotaBytes=256 in makeHost default; a 300-char string will exceed it
    const bigValue = 'x'.repeat(300)

    await expect(host.set('plugin-a', 'big', bigValue)).rejects.toMatchObject({
      code: 'plugin.storage.quota_exceeded',
    })
  })

  // Test 8a: BigInt is not serializable
  it('BigInt throws plugin.storage.value_not_serializable', async () => {
    await expect(host.set('plugin-a', 'k', 1n)).rejects.toMatchObject({
      code: 'plugin.storage.value_not_serializable',
    })
  })

  // Test 8b: class with throwing toJSON is not serializable
  it('class with throwing toJSON throws plugin.storage.value_not_serializable', async () => {
    class Bad {
      toJSON() {
        throw new Error('cannot serialize')
      }
    }

    await expect(host.set('plugin-a', 'k', new Bad())).rejects.toMatchObject({
      code: 'plugin.storage.value_not_serializable',
    })
  })

  // Test 8c: top-level undefined is not serializable
  it('top-level undefined throws plugin.storage.value_not_serializable', async () => {
    await expect(host.set('plugin-a', 'k', undefined)).rejects.toMatchObject({
      code: 'plugin.storage.value_not_serializable',
    })
  })

  // Test 9: delete returns correct boolean
  it('delete returns {deleted: true} for existing key, {deleted: false} for missing', async () => {
    await host.set('plugin-a', 'k', 'v')

    const r1 = await host.delete('plugin-a', 'k')
    expect(r1).toEqual({ deleted: true })

    const r2 = await host.delete('plugin-a', 'k')
    expect(r2).toEqual({ deleted: false })
  })

  // Test 10: cross-plugin isolation
  it('cross-plugin isolation: plugin-a cannot see plugin-b data', async () => {
    await host.set('plugin-b', 'shared', 'secret')

    const result = await host.get('plugin-a', 'shared')
    expect(result).toEqual({ value: undefined, version: 0 })
  })

  // Test 11: deleteAll uninstall cascade — I14 invariant
  it('deleteAll purges every row for one plugin and leaves siblings intact', async () => {
    await host.set('plugin-a', 'k1', 'v1')
    await host.set('plugin-a', 'k2', 'v2')
    await host.set('plugin-b', 'k3', 'v3')

    const result = await host.deleteAll('plugin-a')
    expect(result).toEqual({ deleted: 2 })

    expect(await host.keys('plugin-a')).toEqual([])
    expect(await host.get('plugin-b', 'k3')).toEqual({
      value: 'v3',
      version: 1,
    })
  })

  it('deleteAll on a plugin with no rows returns deleted: 0', async () => {
    const result = await host.deleteAll('plugin-unknown')
    expect(result).toEqual({ deleted: 0 })
  })
})
