import type {
  BackendCompatibilityFailureReason,
  RemoteConnectionFailureReason,
} from '@/background/ConnectionManager'
import type { PairingFailureReason } from '@/background/mbp1/pairing-flow'
import type { ReconnectFailureReason } from '@/background/mbp1/reconnect-flow'

/**
 * Locale key for every connection-failure reason the background can report.
 *
 * `PairingFlowError`/`ReconnectFlowError` messages are developer-facing
 * English sentences (they also go to logs); what a person sees must come
 * from the locale catalog instead, keyed by the stable `reason` code. The
 * `Record` over every typed reason union is deliberate: adding a reason to a
 * flow or compatibility preflight without copy here fails `tsc`, not the user.
 */
export const REASON_KEYS: Record<
  | PairingFailureReason
  | ReconnectFailureReason
  | BackendCompatibilityFailureReason
  | RemoteConnectionFailureReason
  | 'storedPairingUnavailable',
  string
> = {
  storedPairingUnavailable: 'errors.connection.storedPairingUnavailable',
  backoffLocked: 'errors.connection.backoffLocked',
  staleAttempt: 'errors.connection.staleAttempt',
  aborted: 'errors.connection.aborted',
  deadlineExceeded: 'errors.connection.deadlineExceeded',
  runsExhausted: 'errors.connection.runsExhausted',
  invalidCode: 'errors.connection.invalidCode',
  missingNonce: 'errors.connection.missingNonce',
  unsupportedBrowser: 'errors.connection.unsupportedBrowser',
  ticketWithoutBindingKeypair: 'errors.connection.ticketPreparationFailed',
  ticketBindingKeyMismatch: 'errors.connection.ticketPreparationFailed',
  malformedTicket: 'errors.connection.ticketPreparationFailed',
  protocolViolation: 'errors.connection.protocolViolation',
  unsupportedVersion: 'errors.connection.unsupportedVersion',
  peerRejected: 'errors.connection.peerRejected',
  peerBusy: 'errors.connection.peerBusy',
  identityK: 'errors.connection.securityCheckFailed',
  peerNotAuthentic: 'errors.connection.peerNotAuthentic',
  credentialPhaseFailed: 'errors.connection.credentialPhaseFailed',
  internalError: 'errors.connection.internalError',
  authFailed: 'errors.connection.authFailed',
  serverMacMismatch: 'errors.connection.serverMacMismatch',
  superseded: 'errors.connection.staleAttempt',
  channelClosed: 'errors.connection.channelClosed',
  channelUnavailable: 'errors.connection.channelUnavailable',
  backendUpgradeRequired: 'errors.connection.backendUpgradeRequired',
  extensionUpgradeRequired: 'errors.connection.extensionUpgradeRequired',
  unsupportedRemote: 'errors.connection.unsupportedRemote',
  remoteDiscoveryUnavailable: 'errors.connection.remoteDiscoveryUnavailable',
  remotePairingUnavailable: 'errors.connection.remotePairingUnavailable',
  remoteTransportUnavailable: 'errors.connection.remoteTransportUnavailable',
}

/**
 * Reasons are an open set at this seam — a background build can report a
 * code this popup has never heard of, and untyped errors carry no code at
 * all — so anything unmapped falls back to the generic copy.
 */
export function connectionErrorKey(reason: string | null): string {
  const known = (REASON_KEYS as Record<string, string | undefined>)[
    reason ?? ''
  ]
  return known ?? 'errors.connection.generic'
}
