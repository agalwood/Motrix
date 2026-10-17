import { spawn as nodeSpawn } from 'node:child_process'

/**
 * Locate and probe the yt-dlp executable.
 *
 * Mirrors the FFmpeg locator contract: candidate order is fixed and
 * non-executing for the lookup, then one cheap `--version` probe confirms the
 * winner. Nothing here imports Electron or a shell layer.
 */

export interface YtdlpLocation {
  available: boolean
  binaryPath: string | null
  version: string | null
}

export interface YtdlpProbe {
  available: boolean
  version: string | null
  /** Candidate failed the probe; used by Settings UI to explain why. */
  failureReason?: 'missing' | 'unsupported'
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { shell?: boolean }
) => {
  stdout: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): void
  }
  stderr: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): void
  }
  on(event: 'error', listener: (error: Error) => void): void
  on(
    event: 'close',
    listener: (code: number | null, signal: string | null) => void
  ): void
  kill(signal?: string): void
}

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const YTDLP_ENV_VAR = 'MOTRIX_YT_DLP_PATH'

/** Bare command names tried against PATH when nothing is configured. */
export const YTDLP_PATH_COMMANDS: readonly string[] =
  process.platform === 'win32'
    ? ['yt-dlp.exe', 'yt-dlp', 'youtube-dl.exe', 'youtube-dl']
    : ['yt-dlp', 'youtube-dl']

export interface YtdlpCandidateOptions {
  configuredPath?: string
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  homeDir?: string
}

/** Standard install directories where package managers and install scripts place yt-dlp. */
export function standardYtdlpLocations(options?: {
  platform?: NodeJS.Platform
  homeDir?: string
  env?: Record<string, string | undefined>
}): string[] {
  const platform = options?.platform ?? process.platform
  const env = options?.env ?? process.env
  let home = options?.homeDir ?? env.HOME ?? env.USERPROFILE
  if (!home) {
    try {
      home = os.homedir()
    } catch {
      home = undefined
    }
  }

  const list: string[] = []
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    if (localAppData) {
      list.push(path.join(localAppData, 'Programs', 'yt-dlp', 'yt-dlp.exe'))
    }
    if (home) {
      list.push(path.join(home, 'yt-dlp.exe'))
    }
  } else {
    if (home) {
      list.push(path.join(home, '.local', 'bin', 'yt-dlp'))
      list.push(path.join(home, '.local', 'bin', 'youtube-dl'))
    }
    if (platform === 'darwin') {
      list.push('/opt/homebrew/bin/yt-dlp')
      list.push('/usr/local/bin/yt-dlp')
      list.push('/opt/homebrew/bin/youtube-dl')
      list.push('/usr/local/bin/youtube-dl')
    } else {
      list.push('/usr/local/bin/yt-dlp')
      list.push('/usr/bin/yt-dlp')
      list.push('/usr/local/bin/youtube-dl')
      list.push('/usr/bin/youtube-dl')
    }
  }
  return list
}

/**
 * Candidate executable paths in resolution order:
 *   1. user setting (Settings → Media → yt-dlp path)
 *   2. MOTRIX_YT_DLP_PATH environment variable
 *   3. bare command names resolved against PATH by the OS
 *   4. standard user/system install locations (e.g. ~/.local/bin/yt-dlp)
 */
export function ytdlpCandidatesInOrder(input: YtdlpCandidateOptions): string[] {
  const candidates: string[] = []
  const configured = input.configuredPath?.trim()
  if (configured) candidates.push(configured)
  const fromEnv = input.env?.[YTDLP_ENV_VAR]?.trim()
  if (fromEnv && !candidates.includes(fromEnv)) candidates.push(fromEnv)
  for (const command of YTDLP_PATH_COMMANDS) {
    if (!candidates.includes(command)) candidates.push(command)
  }
  for (const standard of standardYtdlpLocations(input)) {
    if (!candidates.includes(standard)) candidates.push(standard)
  }
  return candidates
}

const PROBE_TIMEOUT_MS = 8_000

/**
 * Run `<binaryPath> --version` and report availability.
 *
 * A path-like candidate that does not exist on disk is skipped without
 * spawning, matching the FFmpeg detector, so a stale Settings value cannot
 * trigger an OS prompt or a shell error dialog.
 */
export function probeYtdlp(
  binaryPath: string,
  spawnImpl: SpawnLike = nodeSpawn as unknown as SpawnLike,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<YtdlpProbe> {
  const isPathLike = binaryPath.includes('/') || binaryPath.includes('\\')
  if (isPathLike && !existsSync(binaryPath)) {
    return Promise.resolve({
      available: false,
      version: null,
      failureReason: 'missing' as const,
    })
  }
  return runProbe(binaryPath, spawnImpl, timeoutMs)
}

function runProbe(
  binaryPath: string,
  spawnImpl: SpawnLike,
  timeoutMs: number
): Promise<YtdlpProbe> {
  return new Promise<YtdlpProbe>((resolve) => {
    let settled = false
    let stdout = ''
    let child: ReturnType<SpawnLike> | null = null
    const settle = (result: YtdlpProbe) => {
      if (settled) return
      settled = true
      timer && clearTimeout(timer)
      resolve(result)
    }
    try {
      child = spawnImpl(binaryPath, ['--version'], { shell: false })
    } catch {
      settle({
        available: false,
        version: null,
        failureReason: 'missing' as const,
      })
      return
    }
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL')
      } catch {
        // Process already exited; nothing to reap.
      }
      settle({ available: false, version: null })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.on('error', () =>
      settle({
        available: false,
        version: null,
        failureReason: 'missing' as const,
      })
    )
    child.on('close', (code) => {
      // yt-dlp and youtube-dl both print a calendar version first; anything
      // else that answers `--version` is not the extractor we asked for.
      const version =
        /^v?(\d{4}\.\d+\.\d+\S*)/m.exec(stdout.trim())?.[1] ?? null
      if (code === 0 && version) {
        settle({ available: true, version })
        return
      }
      // A candidate that ran but printed no version is not yt-dlp.
      settle({
        available: false,
        version: null,
        failureReason: 'unsupported' as const,
      })
    })
  })
}

/** First candidate that probes as a working yt-dlp. */
export async function locateYtdlp(
  input: {
    configuredPath?: string
    env?: Record<string, string | undefined>
  },
  probe: (candidate: string) => Promise<YtdlpProbe> = probeYtdlp
): Promise<YtdlpLocation> {
  for (const candidate of ytdlpCandidatesInOrder(input)) {
    const result = await probe(candidate)
    if (result.available) {
      return { available: true, binaryPath: candidate, version: result.version }
    }
  }
  return { available: false, binaryPath: null, version: null }
}
