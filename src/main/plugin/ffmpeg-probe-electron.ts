// Resolve candidates and check trust before executing any version probe.
// Managed macOS CLI tools require authenticated metadata, hashes and Apple's
// online notarized code requirement. Legacy official binaries get the same
// CLI checks after authenticating against their signed release. Other
// external paths keep their Gatekeeper assessment, without fallback on denial.

import path from 'node:path'
import {
  assertManagedFfmpegTrusted,
  FfmpegDownloadUnavailableError,
  resolveManagedFfmpegCandidate,
  verifyLegacyMacFfmpeg,
} from '@core/ffmpeg/verified-install'
import {
  type FfmpegDetection,
  type FfmpegDetectionFailureReason,
  probeBinary,
} from '@core/plugin/capabilities/ffmpeg-detect'
import {
  FFMPEG_REPOSITORY,
  type FfmpegTarget,
} from '@shared/schemas/ffmpeg-release'
import { type RunCommand, runCommand } from '../cli/command-runner'
import { resolveExecutable } from '../cli/shell-environment'
import {
  verifyMacFfmpegBinaryTrust,
  verifyMacFfmpegTrust,
} from './ffmpeg-macos-trust'

const XATTR_BIN = '/usr/bin/xattr'
const SPCTL_BIN = '/usr/sbin/spctl'
const STATIC_CHECK_TIMEOUT_MS = 3_000
const STATIC_CHECK_MAX_BUFFER = 64_000

export type ElectronFfmpegProbeFailureReason = FfmpegDetectionFailureReason

export interface ElectronFfmpegProbeResult extends FfmpegDetection {
  failureReason?: ElectronFfmpegProbeFailureReason
}

type ResolveFfmpegExecutable = (
  name: string,
  env: NodeJS.ProcessEnv,
  dependencies?: { platform?: NodeJS.Platform }
) => Promise<string | null>

type ProbeFfmpegBinary = (
  binaryPath: string
) => Promise<ElectronFfmpegProbeResult>

export interface ElectronFfmpegProbeOptions {
  userDataDir?: string
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  fetcher?: typeof fetch
  run?: RunCommand
  resolve?: ResolveFfmpegExecutable
  probe?: ProbeFfmpegBinary
}

function unavailable(
  failureReason: ElectronFfmpegProbeFailureReason,
  binaryPath?: string
): ElectronFfmpegProbeResult {
  return { available: false, binaryPath, failureReason }
}

/**
 * Create a probe suitable for injection into `detectInOrder`.
 *
 * Official macOS CLI binaries require authenticated release and OS evidence;
 * other quarantined candidates are only executed when `spctl` accepts them.
 * Failures to run either static inspection tool are handled conservatively.
 */
export function makeElectronFfmpegProbe(
  options: ElectronFfmpegProbeOptions = {}
): ProbeFfmpegBinary {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const run = options.run ?? runCommand
  const resolve = options.resolve ?? resolveExecutable
  const probe = options.probe ?? probeBinary
  const pathApi = platform === 'win32' ? path.win32 : path

  return async (candidate) => {
    let resolved: string | null
    let managedTarget: FfmpegTarget | undefined
    try {
      if (
        options.userDataDir &&
        ['darwin', 'linux', 'win32'].includes(platform)
      ) {
        candidate = resolveManagedFfmpegCandidate(
          options.userDataDir,
          candidate,
          platform as 'darwin' | 'linux' | 'win32'
        )
      }
      resolved = await resolve(candidate, env, { platform })
      if (options.userDataDir && resolved) {
        managedTarget = assertManagedFfmpegTrusted(
          options.userDataDir,
          resolved
        )
      }
    } catch {
      return unavailable(options.userDataDir ? 'untrusted' : 'missing')
    }

    if (!resolved || !pathApi.isAbsolute(resolved)) {
      return unavailable('missing')
    }

    if (platform !== 'darwin') return probe(resolved)

    if (managedTarget) {
      try {
        await verifyMacFfmpegTrust(
          path.dirname(resolved),
          managedTarget,
          `https://github.com/${FFMPEG_REPOSITORY}/releases/download/v${managedTarget.releaseVersion}/${managedTarget.archive}`,
          run
        )
      } catch {
        return unavailable('untrusted', resolved)
      }
      return probe(resolved)
    }

    let quarantineResult: Awaited<ReturnType<RunCommand>>
    try {
      quarantineResult = await run(XATTR_BIN, [resolved], {
        env,
        timeoutMs: STATIC_CHECK_TIMEOUT_MS,
        maxBuffer: STATIC_CHECK_MAX_BUFFER,
      })
    } catch {
      return unavailable('untrusted', resolved)
    }

    if (
      quarantineResult.code !== 0 ||
      quarantineResult.timedOut ||
      quarantineResult.spawnError ||
      quarantineResult.truncated
    ) {
      return unavailable('untrusted', resolved)
    }

    const attributes = quarantineResult.stdout.split(/\r?\n/)
    if (!attributes.includes('com.apple.quarantine')) return probe(resolved)

    if (
      options.userDataDir &&
      resolved === path.resolve(options.userDataDir, 'binaries', 'ffmpeg')
    ) {
      try {
        const arch = options.arch ?? process.arch
        if (arch !== 'arm64' && arch !== 'x64')
          return unavailable('untrusted', resolved)
        await verifyLegacyMacFfmpeg({
          userDataDir: options.userDataDir,
          binaryPath: resolved,
          arch,
          fetcher:
            options.fetcher ??
            (await import('./ffmpeg-fetch-electron')).fetchFfmpegAsset,
          systemTrust: (binary, target) =>
            verifyMacFfmpegBinaryTrust(binary, 'ffmpeg', target, run),
        })
      } catch (error) {
        if (error instanceof FfmpegDownloadUnavailableError)
          return unavailable('verification_unavailable', resolved)
        return unavailable('untrusted', resolved)
      }
      return probe(resolved)
    }

    let assessmentResult: Awaited<ReturnType<RunCommand>>
    try {
      assessmentResult = await run(
        SPCTL_BIN,
        ['--assess', '--type', 'execute', '--verbose=4', resolved],
        {
          env,
          timeoutMs: STATIC_CHECK_TIMEOUT_MS,
          maxBuffer: STATIC_CHECK_MAX_BUFFER,
        }
      )
    } catch {
      return unavailable('untrusted', resolved)
    }

    if (
      assessmentResult.code !== 0 ||
      assessmentResult.timedOut ||
      assessmentResult.spawnError ||
      assessmentResult.truncated
    ) {
      return unavailable('untrusted', resolved)
    }

    return probe(resolved)
  }
}
