import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import type {
  TaskCreateCommandResult,
  TorrentDuplicateConflict,
} from '@shared/schemas/add-task'
import type { DownloadTask } from '@shared/types/task'
import { TaskInstancePhase, TaskStatus, TaskType } from '@shared/types/task'

const HEX_INFO_HASH_RE = /^[a-f0-9]{40}$/i
const BASE32_INFO_HASH_RE = /^[a-z2-7]{32}$/i
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const admissionTails = new Map<string, Promise<void>>()

/**
 * Serialize inspection plus engine admission for one content identity. aria2
 * registers info hashes globally, so two otherwise-valid requests must not
 * both observe an empty TaskManager before either publishes its owner.
 */
export async function acquireBtInfoHashAdmission(
  infoHash: string
): Promise<() => void> {
  const key = normalizeBtInfoHash(infoHash) ?? infoHash.toLowerCase()
  const previous = admissionTails.get(key) ?? Promise.resolve()
  let releaseCurrent!: () => void
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  admissionTails.set(key, current)
  await previous

  let released = false
  return () => {
    if (released) return
    released = true
    releaseCurrent()
    if (admissionTails.get(key) === current) admissionTails.delete(key)
  }
}

export class TorrentDuplicateConflictError extends AppError {
  constructor(public readonly conflict: TorrentDuplicateConflict) {
    super(
      ErrorCode.TorrentDuplicateConflict,
      `Torrent duplicate conflict: ${conflict.reason}`
    )
    this.name = 'TorrentDuplicateConflictError'
  }
}

export function taskCreateConflictResult(
  error: unknown
): Extract<TaskCreateCommandResult, { outcome: 'conflict' }> | null {
  return error instanceof TorrentDuplicateConflictError
    ? { outcome: 'conflict', conflict: error.conflict }
    : null
}

export type BtDuplicateAdmission =
  | { action: 'create' }
  | { action: 'reuse'; task: DownloadTask; recheck: boolean }
  | { action: 'conflict'; conflict: TorrentDuplicateConflict }

export interface InspectBtDuplicateInput {
  infoHash: string
  saveDir: string
  selectedFiles: readonly number[]
  duplicatePolicy: 'reuse' | 'create-copy'
  excludeTaskId?: string
}

/** Normalize a magnet/torrent BTIH to the 40-character domain form. */
export function normalizeBtInfoHash(value: string): string | null {
  const trimmed = value.trim()
  if (HEX_INFO_HASH_RE.test(trimmed)) return trimmed.toLowerCase()
  if (!BASE32_INFO_HASH_RE.test(trimmed)) return null

  let bits = 0
  let bitCount = 0
  const bytes: number[] = []
  for (const char of trimmed.toUpperCase()) {
    const digit = BASE32_ALPHABET.indexOf(char)
    if (digit < 0) return null
    bits = (bits << 5) | digit
    bitCount += 5
    while (bitCount >= 8) {
      bitCount -= 8
      bytes.push((bits >> bitCount) & 0xff)
      bits &= (1 << bitCount) - 1
    }
  }
  if (bytes.length !== 20) return null
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function extractMagnetInfoHash(uri: string): string | null {
  try {
    const params = new URL(uri).searchParams
    for (const xt of params.getAll('xt')) {
      const match = /^urn:btih:(.+)$/i.exec(xt)
      if (match) return normalizeBtInfoHash(match[1])
    }
  } catch {
    // Invalid magnet URIs are rejected by the request schema/engine path.
  }
  return null
}

export function inspectBtDuplicate(
  tasks: readonly DownloadTask[],
  input: InspectBtDuplicateInput
): BtDuplicateAdmission {
  const infoHash = normalizeBtInfoHash(input.infoHash)
  if (!infoHash) return { action: 'create' }
  const targetDir = canonicalBtPath(input.saveDir)
  const requestedSelection = normalizeSelection(input.selectedFiles)
  const candidates = tasks.filter(
    (task) =>
      task.id !== input.excludeTaskId &&
      normalizeBtInfoHash(task.infoHash ?? '') === infoHash &&
      task.status !== TaskStatus.Removed
  )
  if (candidates.length === 0) return { action: 'create' }

  const sameDir = candidates.filter(
    (task) => btTaskTargetDir(task) === targetDir
  )
  const exact = sameDir.find((task) => {
    const existingSelection = normalizeSelection(task.bt?.selectedFiles ?? [])
    return (
      requestedSelection.length > 0 &&
      selectionsEqual(existingSelection, requestedSelection)
    )
  })

  if (
    input.duplicatePolicy === 'reuse' &&
    exact &&
    exact.status !== TaskStatus.Error &&
    isBtInfoHashRegistered(exact)
  ) {
    return {
      action: 'reuse',
      task: exact,
      recheck: false,
    }
  }

  // A terminal exact match is reusable only when no other legacy duplicate
  // still owns the hash in aria2. This matters for pre-policy databases that
  // may already contain both an errored/completed row and a live downloader.
  const active = candidates.find(
    (task) => task.id !== exact?.id && isBtInfoHashRegistered(task)
  )
  if (active) {
    return conflict('active-info-hash', infoHash, targetDir, active, false)
  }

  if (
    input.duplicatePolicy === 'reuse' &&
    exact &&
    (exact.status === TaskStatus.Completed || exact.status === TaskStatus.Error)
  ) {
    return { action: 'reuse', task: exact, recheck: true }
  }

  const exactOrOtherActive = candidates.find(isBtInfoHashRegistered)
  if (exactOrOtherActive) {
    return conflict(
      'active-info-hash',
      infoHash,
      targetDir,
      exactOrOtherActive,
      false
    )
  }

  if (input.duplicatePolicy === 'reuse' && sameDir.length > 0) {
    return conflict('selection-mismatch', infoHash, targetDir, sameDir[0], true)
  }

  return { action: 'create' }
}

export function reservedBtFinalNames(
  tasks: readonly DownloadTask[],
  saveDir: string,
  excludeTaskId?: string
): string[] {
  const targetDir = canonicalBtPath(saveDir)
  return tasks
    .filter(
      (task) =>
        task.id !== excludeTaskId &&
        task.status !== TaskStatus.Removed &&
        task.finalName.length > 0 &&
        btTaskTargetDir(task) === targetDir
    )
    .map((task) => task.finalName)
}

export function existingFilesConflict(
  infoHash: string,
  targetDir: string
): TorrentDuplicateConflictError {
  const normalized = normalizeBtInfoHash(infoHash) ?? infoHash.toLowerCase()
  return new TorrentDuplicateConflictError({
    reason: 'existing-files',
    infoHash: normalized,
    targetDir: canonicalBtPath(targetDir),
    existingTaskId: null,
    existingTaskName: null,
    existingTaskStatus: null,
    canCreateCopy: true,
  })
}

function conflict(
  reason: TorrentDuplicateConflict['reason'],
  infoHash: string,
  targetDir: string,
  task: DownloadTask,
  canCreateCopy: boolean
): BtDuplicateAdmission {
  return {
    action: 'conflict',
    conflict: {
      reason,
      infoHash,
      targetDir,
      existingTaskId: task.id,
      existingTaskName: task.name,
      existingTaskStatus: task.status,
      canCreateCopy,
    },
  }
}

export function isBtInfoHashRegistered(task: DownloadTask): boolean {
  // MetadataReady has already purged its metadata-only aria2 result. Error is
  // deliberately conservative: a quarantined metadata cleanup can expose an
  // Error task while its engine row is still alive, so a new owner must wait
  // for retry/removal instead of gambling on aria2 accepting the hash.
  return ![
    TaskStatus.Completed,
    TaskStatus.MetadataReady,
    TaskStatus.Removed,
  ].includes(task.status)
}

export function btTaskTargetDir(task: DownloadTask): string {
  const metadataOnly =
    task.type === TaskType.Magnet &&
    task.instances.some(
      (instance) =>
        instance.phase === TaskInstancePhase.MagnetMetadataResolution
    )
  if (metadataOnly && !task.finalName) {
    return canonicalBtPath(task.finalPath || task.saveDir)
  }
  if (task.finalPath) return canonicalBtPath(path.dirname(task.finalPath))
  return canonicalBtPath(task.saveDir)
}

export function canonicalBtPath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function normalizeSelection(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

function selectionsEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
