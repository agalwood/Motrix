import { describe, expect, it } from 'vitest'
import { patchHasRestartKeys, pickDirty } from './form-utils'

describe('pickDirty', () => {
  it('returns undefined for fully clean tree', () => {
    expect(pickDirty({ a: 1, b: 2 }, undefined)).toBeUndefined()
    expect(pickDirty({ a: 1, b: 2 }, {})).toBeUndefined()
  })

  it('picks flat dirty leaf', () => {
    expect(pickDirty({ a: 1, b: 2 }, { a: true })).toEqual({ a: 1 })
  })

  it('walks nested branches', () => {
    expect(
      pickDirty(
        {
          engine: { rpcPort: 16800, listenPort: 6881 },
          app: { theme: 'dark' },
        },
        { engine: { rpcPort: true } }
      )
    ).toEqual({ engine: { rpcPort: 16800 } })
  })

  it('omits branches with no dirty descendants', () => {
    expect(
      pickDirty({ a: { x: 1 }, b: { y: 2 } }, { a: { x: true }, b: {} })
    ).toEqual({ a: { x: 1 } })
  })

  it('returns full subtree when dirty marker is true', () => {
    expect(
      pickDirty(
        { proxy: { scopes: { download: true, updateApp: false } } },
        { proxy: { scopes: true } }
      )
    ).toEqual({ proxy: { scopes: { download: true, updateApp: false } } })
  })
})

describe('patchHasRestartKeys', () => {
  it('returns false for non-engine patch', () => {
    expect(patchHasRestartKeys({ app: { theme: 'dark' } } as never)).toBe(false)
  })

  it('returns true when engine patch contains a RESTART key', () => {
    expect(patchHasRestartKeys({ engine: { rpcPort: 17000 } } as never)).toBe(
      true
    )
  })

  it('returns false for non-RESTART engine key', () => {
    expect(patchHasRestartKeys({ engine: { btMaxPeers: 100 } } as never)).toBe(
      false
    )
  })

  it('returns false for empty patch', () => {
    expect(patchHasRestartKeys({} as never)).toBe(false)
  })

  it('returns false when app patch contains browserBridgeEnabled (hot-applied via BridgeManager)', () => {
    expect(
      patchHasRestartKeys({ app: { browserBridgeEnabled: true } } as never)
    ).toBe(false)
  })

  it('returns false when app patch contains launchAtStartup (hot-applied via syncAutoLaunch)', () => {
    expect(
      patchHasRestartKeys({ app: { launchAtStartup: false } } as never)
    ).toBe(false)
  })

  it('returns false for mixed patch with non-restart app key and non-restart engine key', () => {
    expect(
      patchHasRestartKeys({
        engine: { btMaxPeers: 100 },
        app: { browserBridgeEnabled: false },
      } as never)
    ).toBe(false)
  })
})
