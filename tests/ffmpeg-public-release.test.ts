// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  assertManagedFfmpegTrusted,
  getFfmpegInstallStatus,
  installVerifiedFfmpeg,
  resolveManagedFfmpegCandidate,
} from '@core/ffmpeg/verified-install'
import {
  compareFfmpegReleases,
  verifyFfmpegRelease,
} from '@core/ffmpeg/verified-release'
import { ErrorCode } from '@shared/errors'
import {
  FFMPEG_MINIMUM_RELEASE,
  type FfmpegInstallStatus,
  type FfmpegPlatform,
} from '@shared/schemas/ffmpeg-release'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCommand } from '../src/main/cli/command-runner'
import { verifyMacFfmpegTrust } from '../src/main/plugin/ffmpeg-macos-trust'
import { makeElectronFfmpegProbe } from '../src/main/plugin/ffmpeg-probe-electron'

// macOS-only explicit opt-in: checks actual Apple trust for both Darwin archives.
// Uses only the latest public immutable GitHub Release, never CI artifacts.
// Run: MOTRIX_FFMPEG_PUBLIC_RELEASE_TEST=1 pnpm exec vitest run tests/ffmpeg-public-release.test.ts
const enabled = process.env.MOTRIX_FFMPEG_PUBLIC_RELEASE_TEST === '1'
const directories: string[] = []
async function isolatedData() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'motrix-ffmpeg-public-')
  )
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function checkedInstallation(
  userDataDir: string,
  platform: FfmpegPlatform,
  arch: 'x64' | 'arm64'
) {
  const status = getFfmpegInstallStatus(userDataDir)
  expect(status.phase).toBe('installed')
  const directory = status.directory!
  const verified = verifyFfmpegRelease(
    await readFile(path.join(directory, 'ffmpeg-manifest.json')),
    await readFile(path.join(directory, 'ffmpeg-manifest.json.sig')),
    arch,
    `v${status.releaseVersion}`,
    platform
  )
  expect(
    compareFfmpegReleases(
      verified.manifest.releaseVersion,
      FFMPEG_MINIMUM_RELEASE
    )
  ).toBeGreaterThanOrEqual(0)
  expect(directory).toBe(
    path.join(
      userDataDir,
      'binaries',
      'ffmpeg-verified',
      'releases',
      `${verified.manifestHash}-${platform}-${arch}`
    )
  )
  const candidate = resolveManagedFfmpegCandidate(
    userDataDir,
    path.join(
      userDataDir,
      'binaries',
      platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    ),
    platform
  )
  assertManagedFfmpegTrusted(userDataDir, candidate)
  if (platform === 'darwin') {
    for (const name of [
      verified.target.binaryPath,
      verified.target.ffprobePath,
    ]) {
      const marker = await runCommand(
        '/usr/bin/xattr',
        ['-p', 'com.apple.quarantine', path.join(directory, name)],
        { timeoutMs: 30_000, maxBuffer: 4096 }
      )
      expect(marker.code).toBe(0)
      expect(marker.stdout).toMatch(/^0081;[0-9a-f]+;Motrix;/)
    }
  }
  return { candidate, verified, directory }
}

describe.skipIf(!enabled || process.platform !== 'darwin')(
  'public FFmpeg release download and installation',
  () => {
    it.each([
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'arm64'],
      ['linux', 'x64'],
      ['win32', 'arm64'],
      ['win32', 'x64'],
    ] as const)(
      'verifies the actual %s-%s archive without executing foreign payloads',
      async (platform, arch) => {
        const userDataDir = await isolatedData()
        const progress: FfmpegInstallStatus[] = []
        const result = await installVerifiedFfmpeg({
          userDataDir,
          platform,
          arch,
          onStatus: (status) => progress.push(status),
          systemTrust: platform === 'darwin' ? verifyMacFfmpegTrust : undefined,
        })
        expect(result.ok).toBe(true)
        const { verified } = await checkedInstallation(
          userDataDir,
          platform,
          arch
        )
        expect(result.releaseVersion).toBe(verified.manifest.releaseVersion)
        expect(progress.map((status) => status.phase)).toEqual(
          expect.arrayContaining([
            'metadata',
            'verifying',
            'downloading',
            'extracting',
            'installing',
            'installed',
          ])
        )
        const downloads = progress.filter(
          (status) => status.phase === 'downloading'
        )
        expect(downloads.at(-1)?.bytesReceived).toBe(
          verified.target.archiveSize
        )
        expect(
          downloads.every(
            (status) =>
              status.bytesReceived <= status.bytesTotal &&
              status.bytesTotal === verified.target.archiveSize
          )
        ).toBe(true)
        if (platform === 'darwin')
          expect(
            progress.some((status) => status.phase === 'systemTrust')
          ).toBe(true)
      },
      600_000
    )

    it.skipIf(
      process.platform !== 'darwin' || !['x64', 'arm64'].includes(process.arch)
    )(
      'probes only trusted native macOS code, rejects concurrent operations, rechecks reused files, and retains the old version on network failure',
      async () => {
        const userDataDir = await isolatedData()
        const arch = process.arch as 'x64' | 'arm64'
        let entered!: () => void
        let resume!: () => void
        const started = new Promise<void>((resolve) => {
          entered = resolve
        })
        const released = new Promise<void>((resolve) => {
          resume = resolve
        })
        const fetcher = vi.fn<typeof fetch>(async (input, init) => {
          entered()
          await released
          return fetch(input, init)
        })
        const trustDirectories: string[] = []
        const systemTrust: typeof verifyMacFfmpegTrust = async (
          directory,
          target,
          source
        ) => {
          trustDirectories.push(directory)
          await verifyMacFfmpegTrust(directory, target, source)
        }
        const first = installVerifiedFfmpeg({
          userDataDir,
          platform: 'darwin',
          arch,
          fetcher,
          systemTrust,
        })
        await started
        await expect(
          installVerifiedFfmpeg({
            userDataDir,
            platform: 'darwin',
            arch,
            fetcher,
            systemTrust,
          })
        ).rejects.toMatchObject({ code: ErrorCode.FfmpegInstallBusy })
        expect(fetcher).toHaveBeenCalledTimes(1)
        resume()
        await first
        const installed = await checkedInstallation(userDataDir, 'darwin', arch)
        const probe = makeElectronFfmpegProbe({ userDataDir })
        await expect(
          probe(path.join(userDataDir, 'binaries', 'ffmpeg'))
        ).resolves.toMatchObject({
          available: true,
          binaryPath: installed.candidate,
          version:
            installed.verified.manifest.releaseVersion.split('-motrix.')[0],
        })
        // The production probe above has checked both native binaries' Apple
        // identities and online tickets. Recheck both hashes before this smoke.
        assertManagedFfmpegTrusted(userDataDir, installed.candidate)
        const ffprobe = await runCommand(
          path.join(installed.directory, installed.verified.target.ffprobePath),
          ['-version'],
          { timeoutMs: 5000, maxBuffer: 64_000 }
        )
        expect(ffprobe.code).toBe(0)
        expect(ffprobe.stdout.split(/\r?\n/)[0]).toContain(
          `ffprobe version ${installed.verified.manifest.releaseVersion.split('-motrix.')[0]}`
        )
        const pointer = path.join(
          userDataDir,
          'binaries',
          'ffmpeg-verified',
          'current.json'
        )
        const before = await readFile(pointer)
        await installVerifiedFfmpeg({
          userDataDir,
          platform: 'darwin',
          arch,
          systemTrust,
        })
        expect(trustDirectories.at(-1)).toBe(installed.directory)
        expect(trustDirectories).toHaveLength(3)
        expect(await readFile(pointer)).toEqual(before)
        await expect(
          installVerifiedFfmpeg({
            userDataDir,
            platform: 'darwin',
            arch,
            systemTrust,
            fetcher: async () => new Response('offline', { status: 503 }),
          })
        ).rejects.toThrow()
        expect(await readFile(pointer)).toEqual(before)
        assertManagedFfmpegTrusted(userDataDir, installed.candidate)
      },
      600_000
    )
  }
)
