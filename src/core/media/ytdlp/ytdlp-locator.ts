import { spawn as nodeSpawn } from 'node:child_process'
import {
  isYtdlpAbort,
  spawnResolve,
  throwIfYtdlpAborted,
} from './ytdlp-execution'

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
  options: {
    shell?: boolean
    stdio?: ['pipe', 'pipe', 'pipe']
    detached?: boolean
    windowsHide?: boolean
    env?: NodeJS.ProcessEnv
  }
) => {
  pid?: number
  stdin?: {
    end(input: string): void
    on?(event: 'error', listener: (error: Error) => void): void
  }
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
export async function probeYtdlp(
  binaryPath: string,
  spawnImpl: SpawnLike = nodeSpawn as unknown as SpawnLike,
  timeoutMs = PROBE_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<YtdlpProbe> {
  throwIfYtdlpAborted(signal)
  const isPathLike = binaryPath.includes('/') || binaryPath.includes('\\')
  if (isPathLike && !existsSync(binaryPath)) {
    return { available: false, version: null, failureReason: 'missing' }
  }
  try {
    const result = await spawnResolve(
      binaryPath,
      [
        '--ignore-config',
        '--no-config-locations',
        '--no-plugin-dirs',
        '--version',
      ],
      timeoutMs,
      spawnImpl,
      { input: '', ...(signal ? { signal } : {}) }
    )
    const version =
      /^v?(\d{4}\.\d+\.\d+\S*)/m.exec(result.stdout.trim())?.[1] ?? null
    return result.code === 0 && version
      ? { available: true, version }
      : { available: false, version: null, failureReason: 'unsupported' }
  } catch (error) {
    if (isYtdlpAbort(error)) throw error
    return { available: false, version: null, failureReason: 'missing' }
  }
}

/** First candidate that probes as a working yt-dlp. */
export async function locateYtdlp(
  input: {
    configuredPath?: string
    env?: Record<string, string | undefined>
    signal?: AbortSignal
  },
  probe: (candidate: string, signal?: AbortSignal) => Promise<YtdlpProbe> = (
    candidate,
    signal
  ) => probeYtdlp(candidate, undefined, undefined, signal)
): Promise<YtdlpLocation> {
  for (const candidate of ytdlpCandidatesInOrder(input)) {
    throwIfYtdlpAborted(input.signal)
    const result = await probe(candidate, input.signal)
    throwIfYtdlpAborted(input.signal)
    if (result.available) {
      return { available: true, binaryPath: candidate, version: result.version }
    }
  }
  return { available: false, binaryPath: null, version: null }
}
