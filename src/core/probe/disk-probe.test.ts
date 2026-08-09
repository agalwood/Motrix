import type { DiskProbeResult } from '@shared/types/probe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockProbeDarwin, mockProbeLinux, mockProbeWin32 } = vi.hoisted(() => ({
  mockProbeDarwin: vi.fn(),
  mockProbeLinux: vi.fn(),
  mockProbeWin32: vi.fn(),
}))

vi.mock('./disk-probe-darwin', () => ({
  probeDarwin: mockProbeDarwin,
}))
vi.mock('./disk-probe-linux', () => ({
  probeLinux: mockProbeLinux,
}))
vi.mock('./disk-probe-win32', () => ({
  probeWin32: mockProbeWin32,
}))

import { invalidateProbeCache, probePrecise, probeQuick } from './disk-probe'

const MOCK_RESULT: DiskProbeResult = {
  platform: 'darwin',
  mountPoint: '/',
  fsType: 'apfs',
  diskType: 'ssd',
  isInternal: true,
  isNetworkFs: false,
  freeBytes: 250_000_000_000,
  confidence: 'high',
}

describe('probeQuick', () => {
  it('returns a result with medium or low confidence', () => {
    const result = probeQuick('/Users/x/Downloads')

    expect(result.platform).toBe(process.platform)
    expect(['medium', 'low']).toContain(result.confidence)
  })

  it('includes freeBytes property', () => {
    const result = probeQuick('/Users/x/Downloads')

    expect(result).toHaveProperty('freeBytes')
  })
})

describe('probePrecise', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateProbeCache()
    mockProbeDarwin.mockResolvedValue(MOCK_RESULT)
    mockProbeLinux.mockResolvedValue(MOCK_RESULT)
    mockProbeWin32.mockResolvedValue(MOCK_RESULT)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('dispatches to platform-specific probe', async () => {
    const result = await probePrecise('/Users/x/Downloads')

    expect(result.confidence).toBe('high')
  })

  it('caches repeat probes of the same path', async () => {
    await probePrecise('/Users/x/Downloads')
    await probePrecise('/Users/x/Downloads')

    const totalCalls =
      mockProbeDarwin.mock.calls.length +
      mockProbeLinux.mock.calls.length +
      mockProbeWin32.mock.calls.length

    expect(totalCalls).toBe(1)
  })

  it('keys the cache by resolved path, not a shared mount root', async () => {
    // Two distinct download dirs must each be probed. Previously both
    // resolved to mount point "/" on POSIX and collided into one cache
    // entry, so the second path was served the first path's probe result.
    await probePrecise('/Users/x/Downloads')
    await probePrecise('/Volumes/NAS/Media')

    const totalCalls =
      mockProbeDarwin.mock.calls.length +
      mockProbeLinux.mock.calls.length +
      mockProbeWin32.mock.calls.length

    expect(totalCalls).toBe(2)
  })

  it('re-probes after cache invalidation', async () => {
    await probePrecise('/Users/x/Downloads')
    invalidateProbeCache()
    await probePrecise('/Users/x/Downloads')

    const totalCalls =
      mockProbeDarwin.mock.calls.length +
      mockProbeLinux.mock.calls.length +
      mockProbeWin32.mock.calls.length

    expect(totalCalls).toBe(2)
  })
})
