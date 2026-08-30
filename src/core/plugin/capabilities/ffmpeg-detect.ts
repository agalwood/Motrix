// ffmpeg-detect — runtime-agnostic ffmpeg binary probe.
//
// Provides three exports:
//   - probeBinary(path): spawns `<path> -version`, parses version from stdout.
//   - detectFromCandidates(paths[]): walks candidates sequentially, returns
//     first successful probe.
//   - detectInOrder(input, probe?): richer result for UI consumers. Returns
//     the active winner plus per-candidate state across the 4 detection
//     layers (manual / userData / env / PATH) in a fixed order, regardless
//     of which ones are configured. States: 'active' | 'available' |
//     'missing' | 'untrusted' | 'unconfigured' | 'version_mismatch'. The last
//     is reserved for a future semver gate and never emitted here. The `probe`
//     argument is for test injection; production callers omit it.
//
// Used by shell wrappers (Electron + Server) that supply the candidate list.
// This module MUST NOT import electron, @main/, or @server/.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FfmpegDetectionFailureReason = 'missing' | 'untrusted'

export interface FfmpegDetection {
  available: boolean
  binaryPath?: string
  version?: string
  /** Why a host-specific preflight declined to execute this candidate. */
  failureReason?: FfmpegDetectionFailureReason
}

// ---------------------------------------------------------------------------
// probeBinary
// ---------------------------------------------------------------------------

const VERSION_RE = /ffmpeg version (\S+)/

/**
 * Probe a single binary path by spawning `<binaryPath> -version`.
 *
 * - If the path contains a separator (i.e. it is an absolute/relative path,
 *   not a bare command name) and does not exist on disk, we skip the spawn
 *   and return immediately.
 * - Otherwise we spawn the process, collect stdout, and parse the version.
 * - Hard timeout: 5 seconds. Process is killed on timeout.
 */
export function probeBinary(binaryPath: string): Promise<FfmpegDetection> {
  const isPathLike = binaryPath.includes('/') || binaryPath.includes('\\')
  if (isPathLike && !existsSync(binaryPath)) {
    return Promise.resolve({ available: false })
  }

  return new Promise<FfmpegDetection>((resolve) => {
    let settled = false
    const settle = (result: FfmpegDetection) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let ch: ReturnType<typeof spawn>
    try {
      ch = spawn(binaryPath, ['-version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      settle({ available: false })
      return
    }

    const timer = setTimeout(() => {
      try {
        ch.kill('SIGTERM')
      } catch {
        // ignore kill errors
      }
      settle({ available: false })
    }, 5_000)

    let stdout = ''
    ch.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    ch.on('error', () => {
      clearTimeout(timer)
      settle({ available: false })
    })

    ch.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (code !== 0 && code !== null) {
        settle({ available: false })
        return
      }
      const match = VERSION_RE.exec(stdout)
      if (match) {
        settle({ available: true, binaryPath, version: match[1] })
      } else {
        settle({ available: false })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// detectFromCandidates
// ---------------------------------------------------------------------------

/**
 * Walk the candidate list sequentially, returning the first successful probe.
 * Returns `{available: false}` if all candidates fail.
 */
export async function detectFromCandidates(
  candidates: ReadonlyArray<string>
): Promise<FfmpegDetection> {
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const result = await probeBinary(candidate)
    if (result.available) return result
  }
  return { available: false }
}

// ---------------------------------------------------------------------------
// detectInOrder — enriched per-candidate detection result
// ---------------------------------------------------------------------------

export interface FfmpegDetectionInput {
  /** From MediaSettings.ffmpegBinaryPath; `''` means unconfigured. */
  manualPath: string
  /** userData binaries directory (required; the candidate path is derived). */
  userDataBinariesDir: string
  /** Host platform snapshot used to derive the userData binary name. */
  platform: string
  /** Host-provided environment candidate; `null` means unconfigured. */
  envPath: string | null
}

export type CandidateKind = 'manual' | 'userData' | 'env' | 'path'

export interface FfmpegCandidate {
  kind: CandidateKind
  path: string | null
}

export type CandidateState =
  | 'active'
  | 'available'
  | 'missing'
  | 'untrusted'
  | 'unconfigured'
  | 'version_mismatch'

export interface FfmpegDetectionResult {
  active: { path: string; version: string } | null
  candidates: Array<{
    kind: CandidateKind
    path: string | null
    state: CandidateState
    version?: string
  }>
}

function ffmpegBinName(platform: string): string {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

/**
 * Build the fixed-priority candidate list without touching the filesystem or
 * executing any candidate. Startup discovery and explicit version probing use
 * this same list so their precedence cannot drift.
 */
export function ffmpegCandidatesInOrder(
  input: FfmpegDetectionInput
): FfmpegCandidate[] {
  return [
    { kind: 'manual', path: input.manualPath || null },
    {
      kind: 'userData',
      path: path.join(input.userDataBinariesDir, ffmpegBinName(input.platform)),
    },
    { kind: 'env', path: input.envPath },
    { kind: 'path', path: 'ffmpeg' },
  ]
}

/**
 * Probe all 4 detection layers in fixed order and return a per-candidate
 * report plus the active winner.
 *
 * Order is always: manual → userData → env → path. Every entry is reported,
 * even when unconfigured or missing.
 *
 * State emission:
 *  - `null` path → `'unconfigured'` (no version).
 *  - Probe succeeds and no active winner yet → `'active'`. The result's
 *    `active.path` is `probe.binaryPath ?? candidatePath` (PATH lookup may
 *    rewrite to an absolute path).
 *  - Probe succeeds but a higher-priority candidate already won →
 *    `'available'` (still includes version).
 *  - Probe reports `failureReason: 'untrusted'` → `'untrusted'`.
 *  - Any other probe failure → `'missing'`.
 *  - `'version_mismatch'` is reserved for a future semver gate; this
 *    function never emits it.
 *
 * The optional `probe` parameter is for test injection only.
 */
export async function detectInOrder(
  input: FfmpegDetectionInput,
  probe: (binaryPath: string) => Promise<FfmpegDetection> = probeBinary
): Promise<FfmpegDetectionResult> {
  const candidates: FfmpegDetectionResult['candidates'] = []
  let active: FfmpegDetectionResult['active'] = null

  for (const entry of ffmpegCandidatesInOrder(input)) {
    const p = entry.path
    if (!p) {
      candidates.push({ kind: entry.kind, path: null, state: 'unconfigured' })
      continue
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await probe(p)
    if (result.available) {
      if (active === null) {
        active = {
          path: result.binaryPath ?? p,
          version: result.version ?? '',
        }
        candidates.push({
          kind: entry.kind,
          path: p,
          state: 'active',
          version: result.version,
        })
      } else {
        candidates.push({
          kind: entry.kind,
          path: p,
          state: 'available',
          version: result.version,
        })
      }
    } else {
      candidates.push({
        kind: entry.kind,
        path: p,
        state: result.failureReason === 'untrusted' ? 'untrusted' : 'missing',
      })
    }
  }

  return { active, candidates }
}

/**
 * Projects a `FfmpegDetectionResult` (enriched per-candidate state) to the
 * legacy `FfmpegDetection` shape consumed by FfmpegCapabilityHost.
 *
 * Treats `active.version === ''` as "no version" (matches the sentinel
 * detectInOrder emits when probeBinary can't parse a version string).
 */
export function projectActiveToLegacy(
  result: FfmpegDetectionResult
): FfmpegDetection {
  return result.active
    ? {
        available: true,
        version: result.active.version || undefined,
        binaryPath: result.active.path,
      }
    : { available: false }
}
