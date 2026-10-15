import { describe, expect, it } from 'vitest'
import type { SiteAdapter } from '@/adapters/SiteAdapter'
import { BgAdapterRegistry } from '@/background/AdapterRegistry'

function fakeAdapter(over: Partial<SiteAdapter> = {}): SiteAdapter {
  return {
    id: 'fake',
    version: '0.1.0',
    urlPatterns: ['*://fake.example.com/*'],
    capabilities: ['resolve'],
    matchesUrl: () => true,
    probe: () => ({ handled: true }),
    resolve: async () => {
      throw new Error('not implemented')
    },
    ...over,
  }
}

describe('BgAdapterRegistry', () => {
  it('list() returns AdapterDecl for each registered adapter', () => {
    const reg = new BgAdapterRegistry([
      fakeAdapter({ id: 'a', urlPatterns: ['*://a.com/*'] }),
      fakeAdapter({ id: 'b', urlPatterns: ['*://b.com/*'] }),
    ])
    const decls = reg.list()
    expect(decls).toHaveLength(2)
    expect(decls[0]?.id).toBe('a')
    expect(decls[1]?.id).toBe('b')
  })

  it('findFor matches the right adapter by URL pattern', () => {
    const reg = new BgAdapterRegistry([
      fakeAdapter({ id: 'youtube', urlPatterns: ['*://*.youtube.com/*'] }),
      fakeAdapter({ id: 'vimeo', urlPatterns: ['*://vimeo.com/*'] }),
    ])
    expect(reg.findFor('https://www.youtube.com/watch?v=x')?.id).toBe('youtube')
    expect(reg.findFor('https://vimeo.com/12345')?.id).toBe('vimeo')
    expect(reg.findFor('https://example.com')).toBeNull()
  })

  it('empty default registry returns empty list and no matches', () => {
    const reg = new BgAdapterRegistry([])
    expect(reg.list()).toEqual([])
    expect(reg.findFor('https://anything')).toBeNull()
  })
})
