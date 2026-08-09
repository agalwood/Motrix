import { describe, expect, it, vi } from 'vitest'
import { ConfigCapabilityHost } from './config'

describe('UpdatePluginConfig integration (config.applyExternalChange)', () => {
  it('fires registered onChange listeners with the post-encryption values', async () => {
    const stored: Record<string, unknown> = {}
    const host = new ConfigCapabilityHost({
      pluginId: 'test',
      readValues: () => stored,
      schemaDefaults: {},
      secretFields: new Set(['apiKey']),
    })
    const handler = vi.fn()
    host.onChange(handler)
    stored.apiKey = 'cipher:abc'
    stored.timeout = 60
    host.applyExternalChange([
      { key: 'apiKey', value: 'cipher:abc', previous: undefined },
      { key: 'timeout', value: 60, previous: 30 },
    ])
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith([
      { key: 'apiKey', value: 'cipher:abc', previous: undefined },
      { key: 'timeout', value: 60, previous: 30 },
    ])
  })

  it('does not fire disposed listener', () => {
    const stored: Record<string, unknown> = {}
    const host = new ConfigCapabilityHost({
      pluginId: 'test',
      readValues: () => stored,
      schemaDefaults: {},
      secretFields: new Set(),
    })
    const handler = vi.fn()
    const reg = host.onChange(handler)
    reg.dispose()
    host.applyExternalChange([{ key: 'x', value: 1, previous: 0 }])
    expect(handler).not.toHaveBeenCalled()
  })

  it('swallows handler errors so subsequent handlers still fire', () => {
    const stored: Record<string, unknown> = {}
    const host = new ConfigCapabilityHost({
      pluginId: 'test',
      readValues: () => stored,
      schemaDefaults: {},
      secretFields: new Set(),
    })
    const badHandler = vi.fn(() => {
      throw new Error('handler boom')
    })
    const goodHandler = vi.fn()
    host.onChange(badHandler)
    host.onChange(goodHandler)
    expect(() =>
      host.applyExternalChange([{ key: 'x', value: 1, previous: 0 }])
    ).not.toThrow()
    expect(goodHandler).toHaveBeenCalledOnce()
  })
})
