// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  PLUGIN_SECURITY_FRESHNESS_MS,
  PLUGIN_SECURITY_INTERVAL_MS,
  PLUGIN_SECURITY_MAX_BYTES,
} from '@shared/schemas/plugin-security'
import { securityFixture } from '@test-utils/plugin-security'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginSecurityService } from './security-service'

describe('low-overhead plugin security synchronization', () => {
  let root: string
  let now: number
  const services: PluginSecurityService[] = []
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'motrix-security-'))
    now = Date.parse('2026-10-06T00:00:00Z')
  })
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.stop()))
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  })

  function setup(
    overrides: Partial<
      ConstructorParameters<typeof PluginSecurityService>[0]
    > = {}
  ) {
    const fixture = securityFixture()
    const initialPolicy = fixture.policy(now)
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(fixture.sign(initialPolicy), {
          headers: { etag: '"policy-1"' },
        })
    )
    const options = {
      cachePath: path.join(root, 'policy.json'),
      trust: fixture.trust,
      fetchImpl,
      now: () => now,
      random: () => 0.5,
      ...overrides,
    }
    const service = new PluginSecurityService(options)
    services.push(service)
    return { fixture, service, fetchImpl, options }
  }

  it('coalesces checks, uses 12-hour scheduling, and performs no per-invocation requests', async () => {
    const { service, fetchImpl } = setup()
    await Promise.all([
      service.refresh(),
      service.refresh(),
      service.refresh(true),
    ])
    for (let i = 0; i < 1000; i++)
      expect(
        service.decision({ pluginId: 'alice.demo', version: '1.0.0' })?.blocked
      ).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    now += PLUGIN_SECURITY_INTERVAL_MS - 1
    await service.refresh()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    now += 1
    await service.refresh()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1][1]?.headers).toMatchObject({
      'if-none-match': '"policy-1"',
    })
    expect(fetchImpl.mock.calls[0][0]?.toString()).toBe(
      'https://security.example.test/plugins-v1.json'
    )
  })

  it('persists scheduling across restarts and accepts a valid 304 without extending signed expiry', async () => {
    const { service, options, fetchImpl } = setup()
    await service.refresh()
    const restarted = new PluginSecurityService(options)
    services.push(restarted)
    await restarted.initialize()
    await restarted.refresh()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    now += PLUGIN_SECURITY_INTERVAL_MS
    fetchImpl.mockResolvedValue(new Response(null, { status: 304 }))
    await restarted.refresh()
    expect(restarted.isFresh()).toBe(true)
    now += 8 * 24 * 60 * 60_000
    await restarted.refresh()
    expect(restarted.isFresh()).toBe(false)
    expect(
      restarted.decision({ pluginId: 'alice.demo', version: '1.0.0' })?.blocked
    ).toBe(true)
  })

  it('retains known blocks offline and requires a recent check for first admission', async () => {
    const { service, fetchImpl } = setup()
    expect(service.isFresh()).toBe(false)
    await service.refresh()
    now += 20 * 60 * 60_000
    fetchImpl.mockRejectedValue(new Error('offline'))
    await service.refresh()
    expect(service.isFresh()).toBe(true)
    now += 6 * 60 * 60_000
    expect(service.isFresh()).toBe(false)
    expect(
      service.decision({ pluginId: 'alice.demo', version: '1.0.0' })?.blocked
    ).toBe(true)
    expect(
      service.decision({ pluginId: 'bob.demo', version: '1.0.0' })
    ).toBeUndefined()
  })

  it('rejects rollback, narrowing and invalid signatures without removing known blocks', async () => {
    const { fixture, service, fetchImpl } = setup()
    const first = fixture.policy(now, { revision: 3 })
    fetchImpl.mockResolvedValueOnce(new Response(fixture.sign(first)))
    await service.refresh()
    for (const response of [
      fixture.sign({ ...first, revision: 2 }),
      fixture.sign({ ...first, revision: 4, advisories: [] }),
      securityFixture().sign({ ...first, revision: 4, advisories: [] }),
      '<html>upstream error</html>',
      'x'.repeat(PLUGIN_SECURITY_MAX_BYTES + 1),
    ]) {
      now += PLUGIN_SECURITY_INTERVAL_MS
      fetchImpl.mockResolvedValueOnce(new Response(response))
      await service.refresh(true)
      expect(
        service.decision({ pluginId: 'alice.demo', version: '1.0.0' })?.blocked
      ).toBe(true)
    }
    now += PLUGIN_SECURITY_INTERVAL_MS
    fetchImpl.mockResolvedValueOnce(
      new Response(
        fixture.sign({
          ...first,
          revision: 4,
          advisories: first.advisories.map((entry) => ({
            ...entry,
            status: 'withdrawn',
          })),
        })
      )
    )
    await service.refresh(true)
    expect(
      service.decision({ pluginId: 'alice.demo', version: '1.0.0' })
    ).toBeUndefined()
  })

  it('keeps admission closed when cache is corrupt or newly accepted policy cannot be saved', async () => {
    await writeFile(path.join(root, 'policy.json'), 'broken')
    const { service } = setup({
      writeCache: async () => {
        throw new Error('disk full')
      },
    })
    await service.initialize()
    expect(
      service.decision({ pluginId: 'bob.demo', version: '1.0.0' })?.reason
    ).toBe('unavailable')
    await service.refresh()
    expect(
      service.decision({ pluginId: 'alice.demo', version: '1.0.0' })?.reason
    ).toBe('malware')
    expect(service.isFresh()).toBe(false)
  })

  it('backs off across restarts and respects Retry-After without transmitting inventory', async () => {
    const { service, fetchImpl, options } = setup()
    fetchImpl.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { 'retry-after': '7200' } })
    )
    await service.refresh()
    const cached = JSON.parse(await readFile(options.cachePath, 'utf8'))
    expect(cached.nextCheckAt - now).toBe(2 * 60 * 60_000)
    const restarted = new PluginSecurityService(options)
    services.push(restarted)
    await restarted.refresh()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
    })
  })

  it('spreads startup and makes only two scheduled checks per day', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const { service, fetchImpl } = setup({ now: () => Date.now() })
    await service.initialize()
    service.start()
    await vi.advanceTimersByTimeAsync(17_499)
    expect(fetchImpl).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await service.refresh()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(PLUGIN_SECURITY_FRESHNESS_MS - 17_500)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('leaves an unprovisioned build dormant with no background requests', async () => {
    const { service, fetchImpl } = setup({
      trust: { url: 'https://unused.test/', publicKeys: [], baseline: null },
    })
    await service.initialize()
    service.start()
    await service.refresh(true)
    expect(service.configured).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
