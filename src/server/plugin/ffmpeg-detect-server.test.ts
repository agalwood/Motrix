// ffmpeg-detect-server tests — verifies the factory threads SettingsManager
// (live read on each invocation), userData binaries dir, and env override into
// detectInOrder.
//
// We mock detectInOrder so no real probe runs. SettingsManager is faked
// structurally — the wrapper only reaches .get().media.ffmpegBinaryPath.

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
import type { SettingsManager } from '@core/settings/settings-manager'
import { makeServerFfmpegDetect } from './ffmpeg-detect-server'

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
    manager: fake as unknown as SettingsManager,
    setMedia: (next) => {
      media = next
    },
  }
}

describe('makeServerFfmpegDetect', () => {
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
    const detect = makeServerFfmpegDetect({
      settingsManager: manager,
      userDataDir: '/srv/motrix',
    })
    await detect()
    expect(mockedDetectInOrder).toHaveBeenCalledTimes(1)
    expect(mockedDetectInOrder.mock.calls[0][0].manualPath).toBe(
      '/custom/ffmpeg'
    )
  })

  it('joins userDataDir with "binaries" for userDataBinariesDir', async () => {
    const { manager } = makeSettingsManager({
      ffmpegBinaryPath: '',
      ffmpegStagingMB: 4096,
      ffmpegOpTimeoutSec: 1800,
    })
    const detect = makeServerFfmpegDetect({
      settingsManager: manager,
      userDataDir: '/srv/motrix',
    })
    await detect()
    expect(mockedDetectInOrder.mock.calls[0][0].userDataBinariesDir).toBe(
      path.join('/srv/motrix', 'binaries')
    )
  })

  it('reads MOTRIX_FFMPEG_PATH into envPath', async () => {
    vi.stubEnv('MOTRIX_FFMPEG_PATH', '/opt/custom/ffmpeg')
    const { manager } = makeSettingsManager({
      ffmpegBinaryPath: '',
      ffmpegStagingMB: 4096,
      ffmpegOpTimeoutSec: 1800,
    })
    const detect = makeServerFfmpegDetect({
      settingsManager: manager,
      userDataDir: '/srv/motrix',
    })
    await detect()
    expect(mockedDetectInOrder.mock.calls[0][0].envPath).toBe(
      '/opt/custom/ffmpeg'
    )
  })

  it('passes the Server host platform and normalizes an unset env path', async () => {
    const { manager } = makeSettingsManager({
      ffmpegBinaryPath: '',
      ffmpegStagingMB: 4096,
      ffmpegOpTimeoutSec: 1800,
    })
    const detect = makeServerFfmpegDetect({
      settingsManager: manager,
      userDataDir: '/srv/motrix',
    })
    await detect()
    const arg = mockedDetectInOrder.mock.calls[0][0]
    expect(arg.platform).toBe(process.platform)
    expect(arg.envPath).toBeNull()
  })

  it('re-reads settings on each invocation (live SettingsManager read)', async () => {
    const { manager, setMedia } = makeSettingsManager({
      ffmpegBinaryPath: '/a',
      ffmpegStagingMB: 4096,
      ffmpegOpTimeoutSec: 1800,
    })
    const detect = makeServerFfmpegDetect({
      settingsManager: manager,
      userDataDir: '/srv/motrix',
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
