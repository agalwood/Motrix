import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SpawnedBridge } from './test-helpers'
import { spawnTestBridge } from './test-helpers'

describe('CapabilityBridge I18 gate', () => {
  const spawned: SpawnedBridge[] = []

  afterEach(async () => {
    for (const s of spawned) {
      await s.bridge.dispose()
    }
    spawned.length = 0
  })

  it('rejects http.get at module top-level', async () => {
    const dir = path.resolve(
      __dirname,
      '../../../../tests/fixtures/plugins/test.toplevel-http'
    )
    const r = await spawnTestBridge(dir, { expectFatal: true })
    spawned.push(r)
    expect(r.errorCode).toBe('plugin.lifecycle.activation_capability_violation')
  }, 10_000)

  it('allows hooks.beforeCreate at module top-level', async () => {
    const dir = path.resolve(
      __dirname,
      '../../../../tests/fixtures/plugins/test.toplevel-register-only'
    )
    const r = await spawnTestBridge(dir)
    spawned.push(r)
    expect(r.registrations).toEqual([{ kind: 'hook', key: 'beforeCreate' }])
  }, 10_000)
})
