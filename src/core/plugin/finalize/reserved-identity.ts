import { createHash } from 'node:crypto'
import {
  type ArtifactIdentity,
  artifactContentEquals,
  artifactIdentityEquals,
} from './artifact-identity'
import type { FinalizeReservationOwnership } from './filesystem-adapter'

export function reservationMarker(token: string): Buffer {
  return Buffer.from(`motrix-reservation-v1:${token}\n`)
}

export function reservationMatches(
  actual: ArtifactIdentity,
  token: string
): boolean {
  const marker = reservationMarker(token)
  return (
    actual.kind === 'file' &&
    actual.size === marker.length &&
    actual.sha256 === createHash('sha256').update(marker).digest('hex')
  )
}

/** Call only after verifying the persisted volume UUID against the held root. */
export function reservedArtifactMatches(
  actual: ArtifactIdentity,
  expected: ArtifactIdentity,
  ownership?: FinalizeReservationOwnership
): boolean {
  if (artifactIdentityEquals(actual, expected)) return true
  // Nonempty exFAT files have cluster-based IDs; st_dev is mount-specific.
  // Empty payloads still require exact identity: an empty digest proves no ownership.
  return (
    Boolean(ownership) &&
    actual.kind === 'file' &&
    expected.kind === 'file' &&
    actual.size > 0 &&
    artifactContentEquals(actual, expected) &&
    /^\d+:-?\d+$/.test(actual.platformFileId) &&
    /^\d+:-?\d+$/.test(expected.platformFileId) &&
    actual.platformFileId.split(':')[1] ===
      expected.platformFileId.split(':')[1]
  )
}
