import path from 'node:path'
import { verifyMacFfmpegTrust } from '@core/ffmpeg/ffmpeg-macos-trust'
import {
  assertManagedFfmpegTrusted,
  getFfmpegInstallStatus,
  installVerifiedFfmpeg,
  resolveManagedFfmpegCandidate,
} from '@core/ffmpeg/verified-install'
import {
  type FfmpegDetection,
  probeBinary,
} from '@core/plugin/capabilities/ffmpeg-detect'
import { AppError, ErrorCode } from '@shared/errors'
import {
  FFMPEG_REPOSITORY,
  type FfmpegInstallStatus,
  type FfmpegPlatform,
} from '@shared/schemas/ffmpeg-release'

export async function installServerFfmpeg(
  userDataDir: string,
  onStatus?: (status: FfmpegInstallStatus) => void
) {
  if (
    !['darwin', 'linux', 'win32'].includes(process.platform) ||
    !['x64', 'arm64'].includes(process.arch)
  )
    return { ok: false as const, error: 'unsupported' as const }
  try {
    return await installVerifiedFfmpeg({
      userDataDir,
      arch: process.arch as 'x64' | 'arm64',
      platform: process.platform as FfmpegPlatform,
      onStatus,
      systemTrust: verifyMacFfmpegTrust,
    })
  } catch (error) {
    return {
      ok: false as const,
      error:
        error instanceof AppError && error.code === ErrorCode.FfmpegInstallBusy
          ? ('busy' as const)
          : (getFfmpegInstallStatus(userDataDir).error ?? ('install' as const)),
    }
  }
}

/** Resolve and verify the managed release before executing a version probe. */
export async function probeServerFfmpeg(
  userDataDir: string,
  candidate: string
): Promise<FfmpegDetection> {
  let resolved: string
  try {
    resolved = resolveManagedFfmpegCandidate(userDataDir, candidate)
    const target = assertManagedFfmpegTrusted(userDataDir, resolved)
    if (target?.platform === 'darwin') {
      await verifyMacFfmpegTrust(
        path.dirname(resolved),
        target,
        `https://github.com/${FFMPEG_REPOSITORY}/releases/download/v${target.releaseVersion}/${target.archive}`
      )
    }
  } catch {
    return { available: false, failureReason: 'untrusted' }
  }
  return probeBinary(resolved)
}
