import { describe, expect, it, vi } from 'vitest'
import { locateFfmpeg } from './ffmpeg-locator'

describe('locateFfmpeg', () => {
  it('returns the active binary when PATH probe succeeds', async () => {
    const probe = vi.fn(async (p: string) =>
      p === 'ffmpeg'
        ? { available: true, binaryPath: 'ffmpeg', version: '7.1' }
        : { available: false }
    )
    const r = await locateFfmpeg(
      { manualPath: '', userDataBinariesDir: '/x', envPath: undefined },
      probe
    )
    expect(r.available).toBe(true)
    expect(r.binaryPath).toBe('ffmpeg')
    expect(r.version).toBe('7.1')
  })

  it('reports unavailable when nothing probes', async () => {
    const probe = vi.fn(async () => ({ available: false }))
    const r = await locateFfmpeg(
      { manualPath: '', userDataBinariesDir: '/x' },
      probe
    )
    expect(r.available).toBe(false)
    expect(r.binaryPath).toBeNull()
  })
})
