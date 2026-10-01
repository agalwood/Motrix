// @vitest-environment node
import type { FfmpegTarget } from '@shared/schemas/ffmpeg-release'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeElectronFfmpegProbe } from './ffmpeg-probe-electron'

const guards = vi.hoisted(() => ({
  authenticated: vi.fn(),
  candidate: vi.fn(),
  systemTrust: vi.fn(),
}))
vi.mock('@core/ffmpeg/verified-install', () => ({
  assertManagedFfmpegTrusted: guards.authenticated,
  resolveManagedFfmpegCandidate: guards.candidate,
}))
vi.mock('./ffmpeg-macos-trust', () => ({
  verifyMacFfmpegTrust: guards.systemTrust,
}))

const userDataDir = '/fixture/user-data'
const managedBinary =
  '/fixture/user-data/ffmpeg-verified/releases/verified-darwin-arm64/ffmpeg'
const target = {
  platform: 'darwin',
  arch: 'arm64',
  releaseVersion: '9.0.2-motrix.8',
  archive: 'ffmpeg-9.0.2-motrix.8-darwin-arm64.zip',
} as FfmpegTarget

beforeEach(() => {
  vi.clearAllMocks()
  guards.candidate.mockReturnValue(managedBinary)
  guards.authenticated.mockReturnValue(target)
  guards.systemTrust.mockResolvedValue(undefined)
})
describe('authenticated managed macOS FFmpeg probing', () => {
  it('requires the authenticated target and full CLI notarization before executing the version probe', async () => {
    const probe = vi.fn(async () => ({
      available: true,
      binaryPath: managedBinary,
      version: '9.0.2',
    }))
    const run = vi.fn()
    await expect(
      makeElectronFfmpegProbe({
        userDataDir,
        platform: 'darwin',
        resolve: async () => managedBinary,
        run,
        probe,
      })('/fixture/user-data/binaries/ffmpeg')
    ).resolves.toMatchObject({ available: true })
    expect(guards.authenticated).toHaveBeenCalledWith(
      userDataDir,
      managedBinary
    )
    expect(guards.systemTrust).toHaveBeenCalledWith(
      '/fixture/user-data/ffmpeg-verified/releases/verified-darwin-arm64',
      target,
      'https://github.com/motrixapp/ffmpeg-static/releases/download/v9.0.2-motrix.8/ffmpeg-9.0.2-motrix.8-darwin-arm64.zip',
      run
    )
    expect(guards.systemTrust.mock.invocationCallOrder[0]).toBeLessThan(
      probe.mock.invocationCallOrder[0]
    )
    expect(run).not.toHaveBeenCalled()
  })
  it.each(['invalid receipt', 'missing signature', 'modified binary'])(
    'does not execute code when the managed guard rejects %s',
    async (reason) => {
      guards.authenticated.mockImplementation(() => {
        throw new Error(reason)
      })
      const probe = vi.fn()
      await expect(
        makeElectronFfmpegProbe({
          userDataDir,
          platform: 'darwin',
          resolve: async () => managedBinary,
          probe,
        })('/fixture/user-data/binaries/ffmpeg')
      ).resolves.toMatchObject({ available: false, failureReason: 'untrusted' })
      expect(guards.systemTrust).not.toHaveBeenCalled()
      expect(probe).not.toHaveBeenCalled()
    }
  )
  it.each(['not notarized', 'incorrect identity', 'Apple service unavailable'])(
    'does not execute code when the real CLI checker rejects %s',
    async (reason) => {
      guards.systemTrust.mockRejectedValue(new Error(reason))
      const probe = vi.fn()
      await expect(
        makeElectronFfmpegProbe({
          userDataDir,
          platform: 'darwin',
          resolve: async () => managedBinary,
          probe,
        })('/fixture/user-data/binaries/ffmpeg')
      ).resolves.toMatchObject({ available: false, failureReason: 'untrusted' })
      expect(probe).not.toHaveBeenCalled()
    }
  )
})
