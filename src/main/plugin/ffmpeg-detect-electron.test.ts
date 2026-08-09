// ffmpeg-detect-electron tests — verifies the factory threads SettingsManager
// (live read on each invocation), userData binaries dir, and env override into
// detectInOrder.
//
// Tests under src/main/ use relative imports because vitest.config.ts does not
// alias @main.

import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@core/plugin/capabilities/ffmpeg-detect', () => ({
  detectInOrder: vi.fn(async () => ({
    active: null,
    candidates: [],
  })),
}))

// Import after mock is registered.
import { detectInOrder } from '@core/plugin/capabilities/ffmpeg-detect'
import type { SettingsManager } from '../../core/settings/settings-manager'
import { makeElectronFfmpegDetect } from './ffmpeg-detect-electron'

const mockedDetectInOrder = vi.mocked(detectInOrder)

interface FakeMedia {
  ffmpegBinaryPath: string
  ffmpegStagingMB: number
  ffmpegOpTimeoutSec: number
}

function makeSettingsManager(initial: FakeMedia): {
  manager: SettingsManager
  setMedia: (next: FakeMedia) => void
} {
  let media = initial
  const fake = {
    get: () => ({ media }),
  }
  return {
    // Structural fake — wrapper only reaches .get().media.ffmpegBinaryPath.
    manager: fake as unknown as SettingsManager,
    setMedia: (next) => {
      media = next
    },
  }
}

describe('makeElectronFfmpegDetect', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    mockedDetectInOrder.mockClear()
  })

  it('passes manualPath from SettingsManager.media.ffmpegBinaryPath', async () => {
    const { manager } = makeSettingsManager({
      ffmpegBinaryPath: '/custom/ffmpeg',
      ffmpegStagingMB: 4096,
      ffmpegOpTimeoutSec: 1800,
    })
    const detect = makeElectronFfmpegDetect({
      settingsManager: manager,
      userDataDir: '/tmp/userdata',
    })
    await detect()
    expect(mockedDetectInOrder).toHaveBeenCalledTimes(1)
    const arg = mockedDetectInOrder.mock.calls[0][0]
    expect(arg.manualPath).toBe('/custom/ffmpeg')
  })

  it('joins userDataDir with "binaries" for userDataBinariesDir', async () => {
    const { manager } = makeSettingsManager({
      ffmpegBinaryPath: '',
      ffmpegStagingMB: 4096,
      ffmpegOpTimeoutSec: 1800,
    })
    const detect = makeElectronFfmpegDetect({
      settingsManager: manager,
      userDataDir: '/var/data/Motrix',
    })
    await detect()
    const arg = mockedDetectInOrder.mock.calls[0][0]
    expect(arg.userDataBinariesDir).toBe(
      path.join('/var/data/Motrix', 'binaries')
    )
  })

  it('reads MOTRIX_FFMPEG_PATH into envPath', async () => {
    vi.stubEnv('MOTRIX_FFMPEG_PATH', '/opt/ff')
    const { manager } = makeSettingsManager({
      ffmpegBinaryPath: '',
      ffmpegStagingMB: 4096,
      ffmpegOpTimeoutSec: 1800,
    })
    const detect = makeElectronFfmpegDetect({
      settingsManager: manager,
      userDataDir: '/tmp/userdata',
    })
    await detect()
    const arg = mockedDetectInOrder.mock.calls[0][0]
    expect(arg.envPath).toBe('/opt/ff')
  })

  it('re-reads settings on each invocation (live SettingsManager read)', async () => {
    const { manager, setMedia } = makeSettingsManager({
      ffmpegBinaryPath: '/a',
      ffmpegStagingMB: 4096,
      ffmpegOpTimeoutSec: 1800,
    })
    const detect = makeElectronFfmpegDetect({
      settingsManager: manager,
      userDataDir: '/tmp/userdata',
    })
    await detect()
    expect(mockedDetectInOrder.mock.calls[0][0].manualPath).toBe('/a')

    setMedia({
      ffmpegBinaryPath: '/b',
      ffmpegStagingMB: 4096,
      ffmpegOpTimeoutSec: 1800,
    })
    await detect()
    expect(mockedDetectInOrder.mock.calls[1][0].manualPath).toBe('/b')
  })
})
