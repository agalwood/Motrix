// Electron-host FFmpeg probe with a non-executing macOS trust preflight.
//
// Candidate paths are resolved to an existing executable before any probe is
// attempted. On macOS, quarantined binaries are assessed by Gatekeeper first,
// so a rejected binary is never spawned merely to discover its version.

import path from 'node:path'
import {
  type FfmpegDetection,
  type FfmpegDetectionFailureReason,
  probeBinary,
} from '@core/plugin/capabilities/ffmpeg-detect'
import { type RunCommand, runCommand } from '../cli/command-runner'
import { resolveExecutable } from '../cli/shell-environment'

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
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
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
 * A quarantined macOS candidate is only executed when `spctl` accepts it.
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
    try {
      resolved = await resolve(candidate, env, { platform })
    } catch {
      return unavailable('missing')
    }

    if (!resolved || !pathApi.isAbsolute(resolved)) {
      return unavailable('missing')
    }

    if (platform !== 'darwin') return probe(resolved)

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
      quarantineResult.spawnError
    ) {
      return unavailable('untrusted', resolved)
    }

    const attributes = quarantineResult.stdout.split(/\r?\n/)
    if (!attributes.includes('com.apple.quarantine')) return probe(resolved)

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
      assessmentResult.spawnError
    ) {
      return unavailable('untrusted', resolved)
    }

    return probe(resolved)
  }
}
