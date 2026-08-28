import { beforeEach, describe, expect, it, vi } from 'vitest'

const undiciMock = vi.hoisted(() => {
  const agents: Array<{
    uri: string
    close: ReturnType<typeof vi.fn>
  }> = []

  class ProxyAgent {
    readonly close = vi.fn(async () => undefined)

    constructor(readonly uri: string) {
      agents.push(this)
    }
  }

  return {
    agents,
    fetch: vi.fn(),
    ProxyAgent,
  }
})

vi.mock('undici', () => ({
  fetch: undiciMock.fetch,
  ProxyAgent: undiciMock.ProxyAgent,
}))

import { TrackerProber } from './tracker-prober'

describe('TrackerProber', () => {
  let prober: TrackerProber

  beforeEach(() => {
    vi.restoreAllMocks()
    undiciMock.fetch.mockReset()
    undiciMock.agents.length = 0
    prober = new TrackerProber()
  })

  it('returns empty array for empty input', async () => {
    const result = await prober.probe([], { timeoutMs: 5000 })
    expect(result).toEqual([])
  })

  it('marks HTTP tracker as healthy on successful HEAD', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 })
    )
    const result = await prober.probe(['http://tracker.example.com/announce'], {
      timeoutMs: 5000,
    })
    expect(result).toHaveLength(1)
    expect(result[0].protocol).toBe('http')
    expect(result[0].status).toBe('healthy')
    expect(result[0].successCount).toBe(1)
    expect(result[0].failCount).toBe(0)
  })

  it('marks HTTP tracker as unreachable on fetch error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('connection refused')
    )
    const result = await prober.probe(['https://dead.tracker.com/announce'], {
      timeoutMs: 5000,
    })
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('unreachable')
    expect(result[0].failCount).toBe(1)
  })

  it('uses undici fetch with an HTTP ProxyAgent and closes the agent', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new Error('global fetch must not be used with a proxy')
      )
    undiciMock.fetch
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new Error('tracker unavailable'))

    const result = await prober.probe(
      ['http://healthy.test/announce', 'https://unavailable.test/announce'],
      {
        timeoutMs: 5000,
        proxy: { server: 'http://127.0.0.1:7890' },
      }
    )

    expect(globalFetch).not.toHaveBeenCalled()
    expect(undiciMock.agents).toHaveLength(1)
    expect(undiciMock.agents[0].uri).toBe('http://127.0.0.1:7890')
    expect(undiciMock.fetch).toHaveBeenCalledTimes(2)
    for (const [, init] of undiciMock.fetch.mock.calls) {
      expect(init).toEqual(
        expect.objectContaining({
          method: 'HEAD',
          dispatcher: undiciMock.agents[0],
        })
      )
    }
    expect(undiciMock.agents[0].close).toHaveBeenCalledOnce()
    expect(result.map(({ status }) => status)).toEqual([
      'healthy',
      'unreachable',
    ])
  })

  it('detects protocol from URL scheme', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 })
    )
    const result = await prober.probe(['https://secure.tracker.com/announce'], {
      timeoutMs: 5000,
    })
    expect(result[0].protocol).toBe('https')
  })

  it('classifies slow tracker based on threshold', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(new Response(null)), 100)
        )
    )
    const result = await prober.probe(['http://slow.tracker.com/announce'], {
      timeoutMs: 5000,
      healthyThresholdMs: 50,
    })
    expect(result[0].status).toBe('slow')
  })
})
