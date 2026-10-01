import {
  assertManagedFfmpegTrusted,
  getFfmpegInstallStatus,
  installVerifiedFfmpeg,
  resolveManagedFfmpegCandidate,
} from '@core/ffmpeg/verified-install'
import { AppError, ErrorCode } from '@shared/errors'
import type {
  FfmpegInstallStatus,
  FfmpegPlatform,
} from '@shared/schemas/ffmpeg-release'
import { resolveExecutable } from '../cli/shell-environment'
import { fetchFfmpegAsset } from './ffmpeg-fetch-electron'
import { verifyMacFfmpegTrust } from './ffmpeg-macos-trust'

export async function resolveVerifiedFfmpeg(
  userDataDir: string,
  candidate: string
) {
  try {
    const mapped = resolveManagedFfmpegCandidate(userDataDir, candidate)
    const resolved = await resolveExecutable(mapped, process.env)
    if (resolved) assertManagedFfmpegTrusted(userDataDir, resolved)
    return resolved
  } catch {
    return null
  }
}

export async function installManagedFfmpeg(
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
      fetcher: fetchFfmpegAsset,
    })
  } catch (error) {
    // No remote error text crosses IPC. Failed installs retain the last verified version.
    return {
      ok: false as const,
      error:
        error instanceof AppError && error.code === ErrorCode.FfmpegInstallBusy
          ? ('busy' as const)
          : (getFfmpegInstallStatus(userDataDir).error ?? ('install' as const)),
    }
  }
}
