// @vitest-environment node
import { FfmpegDownloadUnavailableError } from '@core/ffmpeg/verified-install'
import type { FfmpegTarget } from '@shared/schemas/ffmpeg-release'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeElectronFfmpegProbe } from './ffmpeg-probe-electron'

const guards = vi.hoisted(() => ({
  authenticated: vi.fn(),
  candidate: vi.fn(),
  systemTrust: vi.fn(),
  legacy: vi.fn(),
  binaryTrust: vi.fn(),
}))
vi.mock('@core/ffmpeg/verified-install', async (importOriginal) => ({
  FfmpegDownloadUnavailableError: (
    await importOriginal<typeof import('@core/ffmpeg/verified-install')>()
  ).FfmpegDownloadUnavailableError,
  assertManagedFfmpegTrusted: guards.authenticated,
  resolveManagedFfmpegCandidate: guards.candidate,
  verifyLegacyMacFfmpeg: guards.legacy,
}))
vi.mock('./ffmpeg-macos-trust', () => ({
  verifyMacFfmpegTrust: guards.systemTrust,
  verifyMacFfmpegBinaryTrust: guards.binaryTrust,
}))

const userDataDir = '/fixture/user-data'
const managedBinary =
  '/fixture/user-data/binaries/ffmpeg-verified/releases/verified-darwin-arm64/ffmpeg'
const target = {
  platform: 'darwin',
  arch: 'arm64',
  releaseVersion: '9.0.2-motrix.8',
  archive: 'ffmpeg-9.0.2-motrix.8-darwin-arm64.zip',
} as FfmpegTarget

beforeEach(() => {
  vi.resetAllMocks()
  guards.candidate.mockReturnValue(managedBinary)
  guards.authenticated.mockReturnValue(target)
  guards.systemTrust.mockResolvedValue(undefined)
  guards.binaryTrust.mockResolvedValue(undefined)
})

describe('legacy official macOS FFmpeg probing', () => {
  const legacyBinary = '/fixture/user-data/binaries/ffmpeg'
  function setup() {
    guards.candidate.mockReturnValue(legacyBinary)
    guards.authenticated.mockReturnValue(undefined)
    guards.legacy.mockImplementation(async (options) => {
      await options.systemTrust(options.binaryPath, target)
    })
    const run = vi.fn(async () => ({
      code: 0,
      stdout: 'com.apple.quarantine\n',
      stderr: '',
    }))
    const probe = vi.fn(async () => ({
      available: true,
      binaryPath: legacyBinary,
    }))
    const fetcher = vi.fn()
    const detect = makeElectronFfmpegProbe({
      userDataDir,
      platform: 'darwin',
      arch: 'arm64',
      resolve: async () => legacyBinary,
      run,
      probe,
      fetcher,
    })
    return { detect, run, probe, fetcher }
  }
  it('requires signed release authentication and CLI trust before probing a quarantined legacy binary', async () => {
    const { detect, run, probe, fetcher } = setup()
    await expect(detect(legacyBinary)).resolves.toMatchObject({
      available: true,
    })
    expect(guards.legacy).toHaveBeenCalledWith(
      expect.objectContaining({
        userDataDir,
        binaryPath: legacyBinary,
        arch: 'arm64',
        fetcher,
      })
    )
    expect(guards.binaryTrust).toHaveBeenCalledWith(
      legacyBinary,
      'ffmpeg',
      target,
      run
    )
    expect(guards.binaryTrust.mock.invocationCallOrder[0]).toBeLessThan(
      probe.mock.invocationCallOrder[0]
    )
    expect(run.mock.calls).toHaveLength(1)
  })
  it.each(['manifest or hash', 'OS trust'])(
    'does not execute or fall back to spctl after %s rejection',
    async (failure) => {
      const { detect, run, probe } = setup()
      if (failure === 'OS trust')
        guards.binaryTrust.mockRejectedValue(new Error('not notarized'))
      else guards.legacy.mockRejectedValue(new Error('untrusted release'))
      await expect(detect(legacyBinary)).resolves.toMatchObject({
        available: false,
        failureReason: 'untrusted',
      })
      expect(probe).not.toHaveBeenCalled()
      expect(run.mock.calls).toHaveLength(1)
    }
  )
  it('reports metadata outages as incomplete verification without aborting detection or executing the binary', async () => {
    const { detect, probe, run } = setup()
    guards.legacy.mockRejectedValue(new FfmpegDownloadUnavailableError())
    await expect(detect(legacyBinary)).resolves.toMatchObject({
      available: false,
      binaryPath: legacyBinary,
      failureReason: 'verification_unavailable',
    })
    expect(guards.binaryTrust).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    expect(run.mock.calls).toHaveLength(1)
  })
  it('keeps unrelated quarantined paths on the external Gatekeeper policy', async () => {
    guards.candidate.mockReturnValue('/downloads/ffmpeg')
    guards.authenticated.mockReturnValue(undefined)
    const run = vi.fn(async (command: string) => ({
      code: command.endsWith('xattr') ? 0 : 3,
      stdout: 'com.apple.quarantine\n',
      stderr: 'not an app',
    }))
    const probe = vi.fn()
    await expect(
      makeElectronFfmpegProbe({
        userDataDir,
        platform: 'darwin',
        resolve: async () => '/downloads/ffmpeg',
        run,
        probe,
      })('/downloads/ffmpeg')
    ).resolves.toMatchObject({ available: false, failureReason: 'untrusted' })
    expect(guards.legacy).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })
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
      '/fixture/user-data/binaries/ffmpeg-verified/releases/verified-darwin-arm64',
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
