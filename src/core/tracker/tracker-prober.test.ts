import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackerProber } from './tracker-prober'

describe('TrackerProber', () => {
  let prober: TrackerProber

  beforeEach(() => {
    prober = new TrackerProber()
    vi.restoreAllMocks()
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
