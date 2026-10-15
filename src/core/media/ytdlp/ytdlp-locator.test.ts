import { describe, expect, it, vi } from 'vitest'
import {
  locateYtdlp,
  probeYtdlp,
  YTDLP_ENV_VAR,
  ytdlpCandidatesInOrder,
} from './ytdlp-locator'

function fakeChild(options: {
  stdout?: string
  code?: number | null
  error?: Error
}) {
  const stdoutListeners: Array<(chunk: string) => void> = []
  const closeListeners: Array<(code: number | null) => void> = []
  const errorListeners: Array<(error: Error) => void> = []
  return {
    kill: vi.fn(),
    stdout: {
      on: (_e: string, listener: (chunk: string) => void) =>
        void stdoutListeners.push(listener),
    },
    stderr: { on: () => {} },
    on: (event: string, listener: (arg: never) => void) => {
      if (event === 'close') closeListeners.push(listener as never)
      if (event === 'error') errorListeners.push(listener as never)
    },
    finish() {
      if (options.error) {
        for (const listener of errorListeners) listener(options.error)
        return
      }
      for (const listener of stdoutListeners) listener(options.stdout ?? '')
      for (const listener of closeListeners) listener(options.code ?? 0)
    },
  }
}

describe('ytdlpCandidatesInOrder', () => {
  it('prefers the setting, then the environment, then PATH commands', () => {
    const candidates = ytdlpCandidatesInOrder({
      configuredPath: '/opt/yt-dlp',
      env: { [YTDLP_ENV_VAR]: '/home/u/bin/yt-dlp' },
    })
    expect(candidates[0]).toBe('/opt/yt-dlp')
    expect(candidates[1]).toBe('/home/u/bin/yt-dlp')
    expect(candidates).toContain('yt-dlp')
  })

  it('skips an empty setting and an empty environment variable', () => {
    const candidates = ytdlpCandidatesInOrder({
      configuredPath: '   ',
      env: { [YTDLP_ENV_VAR]: '' },
    })
    expect(candidates[0]).toBe('yt-dlp')
    expect(candidates).not.toContain('')
  })

  it('does not repeat a candidate', () => {
    const candidates = ytdlpCandidatesInOrder({
      configuredPath: 'yt-dlp',
    })
    expect(candidates.filter((c) => c === 'yt-dlp')).toHaveLength(1)
  })

  it('includes standard fallback paths such as ~/.local/bin/yt-dlp', () => {
    const candidates = ytdlpCandidatesInOrder({
      env: { HOME: '/home/testuser' },
      platform: 'linux',
      homeDir: '/home/testuser',
    })
    expect(candidates).toContain('/home/testuser/.local/bin/yt-dlp')
    expect(candidates).toContain('/usr/local/bin/yt-dlp')
    expect(candidates).toContain('/usr/bin/yt-dlp')
  })
})

describe('probeYtdlp', () => {
  it('reads the version from stdout', async () => {
    const child = fakeChild({ stdout: '2026.08.19\n' })
    const spawn = vi.fn((() => {
      setTimeout(() => child.finish(), 0)
      return child
    }) as never)
    const result = await probeYtdlp('yt-dlp', spawn as never)
    expect(result).toEqual({ available: true, version: '2026.08.19' })
  })

  it('reports missing when the process fails to start', async () => {
    const child = fakeChild({ error: new Error('ENOENT') })
    const spawn = vi.fn((() => {
      setTimeout(() => child.finish(), 0)
      return child
    }) as never)
    const result = await probeYtdlp('yt-dlp', spawn as never)
    expect(result.available).toBe(false)
    expect(result.failureReason).toBe('missing')
  })

  it('reports unsupported when a candidate runs but is not yt-dlp', async () => {
    const child = fakeChild({ stdout: 'ffmpeg version 6.0\n', code: 0 })
    const spawn = vi.fn((() => {
      setTimeout(() => child.finish(), 0)
      return child
    }) as never)
    const result = await probeYtdlp('yt-dlp', spawn as never)
    expect(result.available).toBe(false)
    expect(result.failureReason).toBe('unsupported')
  })
})

describe('locateYtdlp', () => {
  it('returns the first candidate that probes as available', async () => {
    const probed: string[] = []
    const location = await locateYtdlp(
      { configuredPath: '/missing', env: {} },
      async (candidate) => {
        probed.push(candidate)
        return candidate === 'yt-dlp'
          ? { available: true, version: '2026.1.1' }
          : { available: false, version: null }
      }
    )
    expect(location).toEqual({
      available: true,
      binaryPath: 'yt-dlp',
      version: '2026.1.1',
    })
    expect(probed[0]).toBe('/missing')
  })

  it('reports unavailable when no candidate works', async () => {
    const location = await locateYtdlp({ env: {} }, async () => ({
      available: false,
      version: null,
    }))
    expect(location).toEqual({
      available: false,
      binaryPath: null,
      version: null,
    })
  })
})
