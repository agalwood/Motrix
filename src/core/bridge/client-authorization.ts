import { createHash } from 'node:crypto'
import type { ClientIdentity } from '@shared/protocol/bridge'

/** Non-secret evidence of the exact credential that authenticated a transport.
 * Identity alone is insufficient: re-pairing can rotate a credential and its
 * delegated account while an older request is still reading its body. */
export type BridgeClientCredential =
  | { readonly kind: 'local' }
  | { readonly kind: 'paired-cli'; readonly fingerprint: string }
  | {
      readonly kind: 'extension'
      readonly credentialId: string
      readonly authorizationEpoch: string
    }

export interface AuthenticatedBridgeClient {
  readonly identity: ClientIdentity
  readonly credential: BridgeClientCredential
}

/** A shell may impose additional account authorization after transport auth.
 * Its callback owns request-local identity propagation. Core never interprets
 * NAS accounts or treats a missing binding as machine-owner access. */
export interface BridgeClientAuthorization {
  run<T>(
    client: AuthenticatedBridgeClient,
    operation: () => Promise<T>
  ): Promise<T>
}

export function cliCredentialFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
