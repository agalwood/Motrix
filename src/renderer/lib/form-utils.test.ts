import { describe, expect, it } from 'vitest'
import { pickDirty } from './form-utils'

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
