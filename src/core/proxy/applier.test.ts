import { DEFAULT_PROXY_SETTINGS } from '@shared/schemas/proxy-settings'
import { describe, expect, it, vi } from 'vitest'
import { createProxyApplier } from './applier'
import { proxyToAria2Options } from './serializers'

const baseProxy = {
  ...DEFAULT_PROXY_SETTINGS,
  enabled: true,
  host: 'p',
  port: 80,
}

function makeDeps() {
  return {
    engineSupervisor: { applyProxyChange: vi.fn() },
    trackerManager: { invalidateProxyCache: vi.fn() },
    proxyBridge: {
      reconcile: vi.fn().mockResolvedValue(undefined),
      resolveForDownload: vi.fn(async (settings) =>
        proxyToAria2Options(settings)
      ),
    },
    applyUpdateAppProxy: vi.fn(),
  }
}

describe('proxyApplier.apply', () => {
  it('routes to engine when download scope flips on', async () => {
    const deps = makeDeps()
    const applier = createProxyApplier(deps)
    await applier.apply(
      {
        ...baseProxy,
        scopes: { download: false, updateApp: false, updateTrackers: false },
      },
      {
        ...baseProxy,
        scopes: { download: true, updateApp: false, updateTrackers: false },
      }
    )
    expect(deps.engineSupervisor.applyProxyChange).toHaveBeenCalledWith({
      allProxy: 'http://p:80',
      noProxy: '',
    })
  })

  it('routes to engine with null when download scope flips off', async () => {
    const deps = makeDeps()
    const applier = createProxyApplier(deps)
    await applier.apply(
      {
        ...baseProxy,
        scopes: { download: true, updateApp: false, updateTrackers: false },
      },
      {
        ...baseProxy,
        scopes: { download: false, updateApp: false, updateTrackers: false },
      }
    )
    expect(deps.engineSupervisor.applyProxyChange).toHaveBeenCalledWith(null)
  })

  it('routes SOCKS5 downloads through the resolved local bridge', async () => {
    const deps = makeDeps()
    deps.proxyBridge.resolveForDownload.mockResolvedValue({
      allProxy: 'http://127.0.0.1:43123',
      noProxy: '',
    })
    const applier = createProxyApplier(deps)

    await applier.apply(
      {
        ...baseProxy,
        scopes: { download: false, updateApp: false, updateTrackers: false },
      },
      {
        ...baseProxy,
        protocol: 'socks5',
        scopes: { download: true, updateApp: false, updateTrackers: false },
      }
    )

    expect(deps.engineSupervisor.applyProxyChange).toHaveBeenCalledWith({
      allProxy: 'http://127.0.0.1:43123',
      noProxy: '',
    })
  })

  it('skips engine when download scope unchanged and fields unchanged', async () => {
    const deps = makeDeps()
    const applier = createProxyApplier(deps)
    const both = {
      ...baseProxy,
      scopes: { download: true, updateApp: false, updateTrackers: false },
    }
    await applier.apply(both, both)
    expect(deps.engineSupervisor.applyProxyChange).not.toHaveBeenCalled()
  })

  it('routes to applyUpdateAppProxy when updateApp scope on and handler injected', async () => {
    const deps = makeDeps()
    const applier = createProxyApplier(deps)
    await applier.apply(
      {
        ...baseProxy,
        scopes: { download: false, updateApp: false, updateTrackers: false },
      },
      {
        ...baseProxy,
        scopes: { download: false, updateApp: true, updateTrackers: false },
      }
    )
    expect(deps.applyUpdateAppProxy).toHaveBeenCalled()
  })

  it('skips updateApp when handler is undefined', async () => {
    const applier = createProxyApplier({
      engineSupervisor: { applyProxyChange: vi.fn() },
      trackerManager: { invalidateProxyCache: vi.fn() },
      proxyBridge: {
        reconcile: vi.fn().mockResolvedValue(undefined),
        resolveForDownload: vi.fn().mockResolvedValue(null),
      },
    })
    // should not throw
    await applier.apply(
      {
        ...baseProxy,
        scopes: { download: false, updateApp: false, updateTrackers: false },
      },
      {
        ...baseProxy,
        scopes: { download: false, updateApp: true, updateTrackers: false },
      }
    )
  })

  it('invalidates tracker cache when updateTrackers flips', async () => {
    const deps = makeDeps()
    const applier = createProxyApplier(deps)
    await applier.apply(
      {
        ...baseProxy,
        scopes: { download: false, updateApp: false, updateTrackers: false },
      },
      {
        ...baseProxy,
        scopes: { download: false, updateApp: false, updateTrackers: true },
      }
    )
    expect(deps.trackerManager.invalidateProxyCache).toHaveBeenCalled()
  })

  it('reconciles the bridge when only updateTrackers flips off', async () => {
    const deps = makeDeps()
    const applier = createProxyApplier(deps)
    const next = {
      ...baseProxy,
      protocol: 'socks5' as const,
      enabled: false,
      scopes: { download: false, updateApp: false, updateTrackers: false },
    }

    await applier.apply(
      {
        ...baseProxy,
        protocol: 'socks5',
        scopes: { download: false, updateApp: false, updateTrackers: true },
      },
      next
    )

    expect(deps.proxyBridge.reconcile).toHaveBeenCalledOnce()
    expect(deps.proxyBridge.reconcile).toHaveBeenCalledWith(next)
    expect(deps.proxyBridge.resolveForDownload).not.toHaveBeenCalled()
  })

  it('applyAll(current) treats old as fully-disabled', async () => {
    const deps = makeDeps()
    const applier = createProxyApplier(deps)
    await applier.applyAll({
      ...baseProxy,
      scopes: { download: true, updateApp: true, updateTrackers: true },
    })
    expect(deps.engineSupervisor.applyProxyChange).toHaveBeenCalled()
    expect(deps.applyUpdateAppProxy).toHaveBeenCalled()
    expect(deps.trackerManager.invalidateProxyCache).toHaveBeenCalled()
  })
})
