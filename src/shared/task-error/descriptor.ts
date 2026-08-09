import type { DownloadErrorCode } from '@shared/errors'

export interface TaskErrorFields {
  errorCode: DownloadErrorCode | null
  errorMessage: string | null
  errorDetailKey: string | null
  errorDetailParams: Record<string, string> | null
}

function detailParamsEqual(
  a: Record<string, string> | null,
  b: Record<string, string> | null
): boolean {
  if (a === null || b === null) return a === b
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((key) => a[key] === b[key])
}

/**
 * Value equality for a task's error group. Shared by the diagnosis CAS
 * (which compares the patched group against the stored row to decide
 * between a no-op and a write) and by its caller, so "unchanged" means the
 * same thing on both sides of the storage boundary.
 */
export function taskErrorFieldsEqual(
  a: TaskErrorFields,
  b: TaskErrorFields
): boolean {
  return (
    a.errorCode === b.errorCode &&
    a.errorMessage === b.errorMessage &&
    a.errorDetailKey === b.errorDetailKey &&
    detailParamsEqual(a.errorDetailParams, b.errorDetailParams)
  )
}

export interface FailureDescriptor {
  reasonCandidates: Array<{ key: string; params?: Record<string, string> }>
  hintKey: string | null
  technicalDetail: string | null
}

export const GENERIC_REASON_KEY = 'task.error.reason.generic'

const ERROR_REASON_LEAF: Readonly<Record<DownloadErrorCode, string>> = {
  DL_UNKNOWN: 'unknown',
  DL_NOT_FOUND: 'notFound',
  DL_UNAUTHORIZED: 'unauthorized',
  DL_NETWORK_ERROR: 'networkError',
  DL_TIMEOUT: 'timeout',
  DL_DISK_FULL: 'diskFull',
  DL_FILE_WRITE_ERROR: 'fileWriteError',
  DL_CHECKSUM_MISMATCH: 'checksumMismatch',
  DL_TOO_MANY_REDIRECTS: 'tooManyRedirects',
  DL_SERVER_ERROR: 'serverError',
  DL_BT_METADATA_FAILED: 'btMetadataFailed',
  DL_BT_TRACKER_ERROR: 'btTrackerError',
} as const

export function resolveFailureDescriptor(
  fields: TaskErrorFields
): FailureDescriptor {
  const reasonCandidates: Array<{
    key: string
    params?: Record<string, string>
  }> = []

  // Add detail key first (if non-empty)
  if (fields.errorDetailKey?.trim()) {
    reasonCandidates.push({
      key: fields.errorDetailKey.trim(),
      ...(fields.errorDetailParams && { params: fields.errorDetailParams }),
    })
  }

  // Add code-based reason (if code exists)
  if (fields.errorCode) {
    const leaf = ERROR_REASON_LEAF[fields.errorCode]
    reasonCandidates.push({
      key: `task.error.reason.${leaf}`,
    })
  }

  // Always add generic at the end
  reasonCandidates.push({
    key: GENERIC_REASON_KEY,
  })

  // Build hint key
  const hintKey = fields.errorCode
    ? `task.error.hint.${ERROR_REASON_LEAF[fields.errorCode]}`
    : null

  // Build technical detail
  const technicalDetail = fields.errorMessage?.trim() || null

  return {
    reasonCandidates,
    hintKey,
    technicalDetail,
  }
}
