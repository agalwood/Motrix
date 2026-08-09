import { DEFAULT_PROXY_SETTINGS } from '@shared/schemas/proxy-settings'
import { describe, expect, it, vi } from 'vitest'
import { createProxyApplier } from './applier'

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
