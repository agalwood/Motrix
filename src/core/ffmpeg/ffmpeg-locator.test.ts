import { describe, expect, it, vi } from 'vitest'
import { locateFfmpeg } from './ffmpeg-locator'

describe('locateFfmpeg', () => {
  it('returns the resolved PATH binary without probing its version', async () => {
    const resolveExecutable = vi.fn(async (p: string) =>
      p === 'ffmpeg' ? '/usr/local/bin/ffmpeg' : null
    )
    const r = await locateFfmpeg(
      {
        manualPath: '',
        userDataBinariesDir: '/x',
        platform: 'linux',
        envPath: null,
      },
      resolveExecutable
    )
    expect(r.available).toBe(true)
    expect(r.binaryPath).toBe('/usr/local/bin/ffmpeg')
    expect(r.version).toBeNull()
    expect(resolveExecutable).toHaveBeenCalledWith('/x/ffmpeg')
    expect(resolveExecutable).toHaveBeenCalledWith('ffmpeg')
  })

  it('preserves manual, user data, environment, then PATH priority', async () => {
    const resolveExecutable = vi.fn(async (candidate: string) =>
      candidate === '/environment/ffmpeg' ? candidate : null
    )
    const r = await locateFfmpeg(
      {
        manualPath: '/manual/ffmpeg',
        userDataBinariesDir: '/user-data/binaries',
        platform: 'linux',
        envPath: '/environment/ffmpeg',
      },
      resolveExecutable
    )

    expect(r).toEqual({
      available: true,
      binaryPath: '/environment/ffmpeg',
      version: null,
    })
    expect(
      resolveExecutable.mock.calls.map(([candidate]) => candidate)
    ).toEqual([
      '/manual/ffmpeg',
      '/user-data/binaries/ffmpeg',
      '/environment/ffmpeg',
    ])
  })

  it('reports unavailable when no executable path resolves', async () => {
    const resolveExecutable = vi.fn(async () => null)
    const r = await locateFfmpeg(
      {
        manualPath: '',
        userDataBinariesDir: '/x',
        platform: 'linux',
        envPath: null,
      },
      resolveExecutable
    )
    expect(r.available).toBe(false)
    expect(r.binaryPath).toBeNull()
    expect(r.version).toBeNull()
  })
})
