import { verifyMacFfmpegTrust } from '@core/ffmpeg/ffmpeg-macos-trust'
import {
  assertManagedFfmpegTrusted,
  getFfmpegInstallStatus,
  installVerifiedFfmpeg,
  resolveManagedFfmpegCandidate,
} from '@core/ffmpeg/verified-install'
import { probeBinary } from '@core/plugin/capabilities/ffmpeg-detect'
import { AppError, ErrorCode } from '@shared/errors'
import type { FfmpegTarget } from '@shared/schemas/ffmpeg-release'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installServerFfmpeg,
  probeServerFfmpeg,
} from './verified-ffmpeg-server'

vi.mock('@core/ffmpeg/verified-install', () => ({
  installVerifiedFfmpeg: vi.fn(),
  getFfmpegInstallStatus: vi.fn(),
  resolveManagedFfmpegCandidate: vi.fn(),
  assertManagedFfmpegTrusted: vi.fn(),
}))
vi.mock('@core/ffmpeg/ffmpeg-macos-trust', () => ({
  verifyMacFfmpegTrust: vi.fn(),
}))
vi.mock('@core/plugin/capabilities/ffmpeg-detect', () => ({
  probeBinary: vi.fn(),
}))

const userDataDir = '/data'
const binary = '/data/binaries/ffmpeg-verified/releases/verified/ffmpeg'
const installed = { ok: true as const, releaseVersion: '9.0.2-motrix.2' }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(installVerifiedFfmpeg).mockResolvedValue(installed)
  vi.mocked(resolveManagedFfmpegCandidate).mockReturnValue(binary)
  vi.mocked(probeBinary).mockResolvedValue({
    available: true,
    binaryPath: binary,
    version: '9.0.2',
  })
})
afterEach(() => vi.restoreAllMocks())

describe('server verified FFmpeg installation', () => {
  it.each(['linux', 'darwin', 'win32'] as const)(
    'uses the %s server target and forwards progress',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
      const onStatus = vi.fn()
      await expect(installServerFfmpeg(userDataDir, onStatus)).resolves.toEqual(
        installed
      )
      expect(installVerifiedFfmpeg).toHaveBeenCalledWith({
        userDataDir,
        platform,
        arch: 'arm64',
        onStatus,
        systemTrust: verifyMacFfmpegTrust,
      })
    }
  )

  it('does not start downloads for unsupported architectures', async () => {
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm')
    await expect(installServerFfmpeg(userDataDir)).resolves.toEqual({
      ok: false,
      error: 'unsupported',
    })
    expect(installVerifiedFfmpeg).not.toHaveBeenCalled()
  })

  it('reports concurrent installs as busy without overwriting the running status', async () => {
    vi.mocked(installVerifiedFfmpeg).mockRejectedValue(
      new AppError(ErrorCode.FfmpegInstallBusy, 'busy')
    )
    await expect(installServerFfmpeg(userDataDir)).resolves.toEqual({
      ok: false,
      error: 'busy',
    })
    expect(getFfmpegInstallStatus).not.toHaveBeenCalled()
  })

  it('returns a bounded failure code without leaking remote errors', async () => {
    vi.mocked(installVerifiedFfmpeg).mockRejectedValue(
      new Error('untrusted remote text')
    )
    vi.mocked(getFfmpegInstallStatus).mockReturnValue({
      phase: 'failed',
      bytesReceived: 0,
      bytesTotal: 0,
      percent: null,
      directory: null,
      releaseVersion: null,
      error: 'verification',
    })
    await expect(installServerFfmpeg(userDataDir)).resolves.toEqual({
      ok: false,
      error: 'verification',
    })
  })
})

describe('server managed FFmpeg detection', () => {
  it('probes the verified release instead of the conventional candidate path', async () => {
    await expect(
      probeServerFfmpeg(userDataDir, '/data/binaries/ffmpeg')
    ).resolves.toMatchObject({ available: true, binaryPath: binary })
    expect(probeBinary).toHaveBeenCalledWith(binary)
    expect(assertManagedFfmpegTrusted).toHaveBeenCalledWith(userDataDir, binary)
  })

  it('never executes a managed binary that fails verification', async () => {
    vi.mocked(resolveManagedFfmpegCandidate).mockImplementation(() => {
      throw new Error('modified binary')
    })
    await expect(
      probeServerFfmpeg(userDataDir, '/data/binaries/ffmpeg')
    ).resolves.toEqual({ available: false, failureReason: 'untrusted' })
    expect(probeBinary).not.toHaveBeenCalled()
  })

  it('requires macOS trust before probing managed tools', async () => {
    vi.mocked(assertManagedFfmpegTrusted).mockReturnValue({
      platform: 'darwin',
      releaseVersion: installed.releaseVersion,
      archive: 'ffmpeg.zip',
    } as FfmpegTarget)
    await probeServerFfmpeg(userDataDir, '/data/binaries/ffmpeg')
    expect(verifyMacFfmpegTrust).toHaveBeenCalledWith(
      '/data/binaries/ffmpeg-verified/releases/verified',
      expect.any(Object),
      `https://github.com/motrixapp/ffmpeg-static/releases/download/v${installed.releaseVersion}/ffmpeg.zip`
    )
    expect(
      vi.mocked(verifyMacFfmpegTrust).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(probeBinary).mock.invocationCallOrder[0])
    vi.mocked(probeBinary).mockClear()
    vi.mocked(verifyMacFfmpegTrust).mockRejectedValue(
      new Error('not notarized')
    )
    await expect(
      probeServerFfmpeg(userDataDir, '/data/binaries/ffmpeg')
    ).resolves.toMatchObject({ available: false, failureReason: 'untrusted' })
    expect(probeBinary).not.toHaveBeenCalled()
  })

  it('keeps manually configured tools usable', async () => {
    vi.mocked(resolveManagedFfmpegCandidate).mockReturnValue('/opt/ffmpeg')
    await probeServerFfmpeg(userDataDir, '/opt/ffmpeg')
    expect(probeBinary).toHaveBeenCalledWith('/opt/ffmpeg')
    expect(verifyMacFfmpegTrust).not.toHaveBeenCalled()
  })
})
