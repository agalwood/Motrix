import { constants } from 'node:os'
import { ArtifactIdentityError } from './artifact-identity'
import { FinalizeFsError } from './filesystem-adapter'

/** Storage absence must block this task's retry without blocking app startup. */
export class FinalizeRecoveryDeferredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FinalizeRecoveryDeferredError'
  }
}

const unavailableCodes = [
  'ENOENT',
  'ENODEV',
  'ENXIO',
  'ESTALE',
  'ENOTCONN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ETIMEDOUT',
] as const

/** Limit startup deferral to missing/disconnected storage, not arbitrary I/O. */
export function isUnavailableArtifactError(error: unknown): boolean {
  if (error instanceof FinalizeRecoveryDeferredError) return true
  if (error instanceof ArtifactIdentityError)
    return error.code === 'artifact_missing'
  if (error instanceof FinalizeFsError) {
    if (error.code === 'not_found') return true
    if (process.platform === 'win32') return false
    const errno = constants.errno as Record<string, number | undefined>
    return (
      error.code === 'io_error' &&
      error.details?.osError !== undefined &&
      unavailableCodes.some((code) => errno[code] === error.details?.osError)
    )
  }
  return (
    error instanceof Error &&
    'code' in error &&
    unavailableCodes.some((code) => code === error.code)
  )
}
