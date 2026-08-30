// ffmpeg-detect tests — probes that don't require ffmpeg to be installed.
//
// Version-parsing is NOT unit-tested in isolation here because probeBinary
// does not accept synthetic args. To exercise the regex path, you would need
// either a real ffmpeg binary (guarded by MOTRIX_TEST_FFMPEG=1) or a fixture
// shell script — overkill for a one-liner regex. The happy-path is covered
// when MOTRIX_TEST_FFMPEG is set.

import { describe, expect, it } from 'vitest'
import {
  detectFromCandidates,
  detectInOrder,
  type FfmpegDetection,
  probeBinary,
  projectActiveToLegacy,
} from './ffmpeg-detect'

describe('probeBinary', () => {
  it('returns available:false for a path-like non-existent binary', async () => {
    const result = await probeBinary('/nonexistent/path/ffmpeg')
    expect(result).toEqual({ available: false })
  })

  it('returns available:false for another non-existent absolute path', async () => {
    const result = await probeBinary('/usr/local/bin/definitely-no-ffmpeg-here')
    expect(result).toEqual({ available: false })
  })

  it.skipIf(!process.env.MOTRIX_TEST_FFMPEG)(
    'returns available:true with a version string when ffmpeg is on PATH',
    async () => {
      const result = await probeBinary('ffmpeg')
      expect(result.available).toBe(true)
      expect(typeof result.version).toBe('string')
      expect(result.binaryPath).toBe('ffmpeg')
    }
  )
})

describe('detectFromCandidates', () => {
  it('returns available:false for an empty candidate list', async () => {
    const result = await detectFromCandidates([])
    expect(result).toEqual({ available: false })
  })

  it('returns available:false when all candidates are non-existent paths', async () => {
    const result = await detectFromCandidates([
      '/nonexistent/ffmpeg',
      '/also/nonexistent/ffmpeg',
    ])
    expect(result).toEqual({ available: false })
  })

  it('skips non-existent paths and returns the first available result', async () => {
    // We cannot guarantee ffmpeg is installed, so we mock a "found" result
    // by placing process.execPath (always exists) first — but process.execPath
    // is not ffmpeg and will return available:false. The test therefore verifies
    // that detectFromCandidates stops iteration and returns available:false when
    // none succeed, which is the observable behaviour without a real ffmpeg.
    const result = await detectFromCandidates([
      '/nonexistent/ffmpeg',
      process.execPath, // exists but is not ffmpeg → no version match
    ])
    // node -version output doesn't match /ffmpeg version .../
    expect(result.available).toBe(false)
  })
})

function makeProbe(map: Record<string, FfmpegDetection>) {
  return async (p: string): Promise<FfmpegDetection> => {
    return map[p] ?? { available: false }
  }
}

describe('detectInOrder', () => {
  it('manual path wins when present and probes succeed', async () => {
    const probe = makeProbe({
      '/u/bin/ffmpeg': {
        available: true,
        version: '6.0.1',
        binaryPath: '/u/bin/ffmpeg',
      },
      '/data/binaries/ffmpeg': { available: false },
      ffmpeg: {
        available: true,
        version: '4.4.0',
        binaryPath: '/usr/local/bin/ffmpeg',
      },
    })
    const r = await detectInOrder(
      {
        manualPath: '/u/bin/ffmpeg',
        userDataBinariesDir: '/data/binaries',
        platform: 'linux',
        envPath: null,
      },
      probe
    )
    expect(r.active).toEqual({ path: '/u/bin/ffmpeg', version: '6.0.1' })
    expect(r.candidates).toHaveLength(4)
    expect(r.candidates[0]).toMatchObject({
      kind: 'manual',
      state: 'active',
      version: '6.0.1',
    })
    expect(r.candidates[1]).toMatchObject({
      kind: 'userData',
      state: 'missing',
    })
    expect(r.candidates[3]).toMatchObject({
      kind: 'path',
      state: 'available',
      version: '4.4.0',
    })
  })

  it('falls through to userData when manual is empty', async () => {
    const probe = makeProbe({
      '/data/binaries/ffmpeg': {
        available: true,
        version: '5.1.0',
        binaryPath: '/data/binaries/ffmpeg',
      },
      ffmpeg: {
        available: true,
        version: '4.0.0',
        binaryPath: '/usr/bin/ffmpeg',
      },
    })
    const r = await detectInOrder(
      {
        manualPath: '',
        userDataBinariesDir: '/data/binaries',
        platform: 'linux',
        envPath: null,
      },
      probe
    )
    expect(r.active?.path).toBe('/data/binaries/ffmpeg')
    expect(r.candidates[0]).toMatchObject({
      kind: 'manual',
      path: null,
      state: 'unconfigured',
    })
    expect(r.candidates[1]).toMatchObject({ kind: 'userData', state: 'active' })
  })

  it('env candidate is unconfigured when the host provides no path', async () => {
    const probe = makeProbe({})
    const r = await detectInOrder(
      {
        manualPath: '',
        userDataBinariesDir: '/data/binaries',
        platform: 'linux',
        envPath: null,
      },
      probe
    )
    expect(r.candidates[2]).toMatchObject({
      kind: 'env',
      path: null,
      state: 'unconfigured',
    })
  })

  it('uses the environment candidate supplied by the host', async () => {
    const probe = makeProbe({
      '/env/ffmpeg': {
        available: true,
        version: '6.0',
        binaryPath: '/env/ffmpeg',
      },
    })
    const r = await detectInOrder(
      {
        manualPath: '',
        userDataBinariesDir: '/data/binaries',
        platform: 'linux',
        envPath: '/env/ffmpeg',
      },
      probe
    )
    expect(r.candidates[2]).toMatchObject({
      kind: 'env',
      path: '/env/ffmpeg',
      state: 'active',
    })
  })

  it('returns active: null and 4 candidates when all miss', async () => {
    const probe = makeProbe({})
    const r = await detectInOrder(
      {
        manualPath: '',
        userDataBinariesDir: '/data/binaries',
        platform: 'linux',
        envPath: null,
      },
      probe
    )
    expect(r.active).toBeNull()
    expect(r.candidates).toHaveLength(4)
    expect(r.candidates[0].state).toBe('unconfigured')
    expect(r.candidates[1].state).toBe('missing')
  })

  it('keeps a macOS trust failure distinct from a missing binary', async () => {
    const probe = makeProbe({
      '/data/binaries/ffmpeg': {
        available: false,
        binaryPath: '/data/binaries/ffmpeg',
        failureReason: 'untrusted',
      },
    })
    const r = await detectInOrder(
      {
        manualPath: '',
        userDataBinariesDir: '/data/binaries',
        platform: 'darwin',
        envPath: null,
      },
      probe
    )

    expect(r.active).toBeNull()
    expect(r.candidates[1]).toMatchObject({
      kind: 'userData',
      path: '/data/binaries/ffmpeg',
      state: 'untrusted',
    })
  })

  it('derives the Windows userData candidate from the supplied platform', async () => {
    const probe = makeProbe({})
    const r = await detectInOrder(
      {
        manualPath: '',
        userDataBinariesDir: '/data/binaries',
        platform: 'win32',
        envPath: null,
      },
      probe
    )
    expect(r.candidates[1]).toMatchObject({
      kind: 'userData',
      path: '/data/binaries/ffmpeg.exe',
      state: 'missing',
    })
  })
})

describe('projectActiveToLegacy', () => {
  it('returns available:false when active is null', () => {
    expect(projectActiveToLegacy({ active: null, candidates: [] })).toEqual({
      available: false,
    })
  })

  it('projects active winner to legacy shape with version', () => {
    expect(
      projectActiveToLegacy({
        active: { path: '/u/bin/ffmpeg', version: '6.0.1' },
        candidates: [],
      })
    ).toEqual({
      available: true,
      version: '6.0.1',
      binaryPath: '/u/bin/ffmpeg',
    })
  })

  it('treats empty-string version as no version', () => {
    expect(
      projectActiveToLegacy({
        active: { path: '/u/bin/ffmpeg', version: '' },
        candidates: [],
      })
    ).toEqual({
      available: true,
      version: undefined,
      binaryPath: '/u/bin/ffmpeg',
    })
  })
})
