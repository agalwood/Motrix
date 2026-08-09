/**
 * Bridge receiver error taxonomy. Codes are wire contract — the extension
 * branches on `code`, not `message`. `message` is already i18n'd by the
 * Motrix side and displayed verbatim in the extension popup.
 *
 * The set below is the v1.0 universe; HLS / mux phases extend it without
 * changing existing codes.
 */
export type BridgeErrorCode =
  | 'invalid-payload'
  | 'invalid-url-scheme'
  | 'unsupported-kind'
  | 'unsupported-live'
  | 'unsupported-master'
  | 'unsupported-encryption'
  | 'auth-expired'
  | 'not-found'
  | 'transient-failure'
  | 'range-not-satisfiable'
  | 'disk-full'
  | 'disk-write-failed'
  | 'mux-failed'
  | 'mux-aborted'
  | 'cancelled'
  | 'internal-error'

/**
 * Thrown by BridgeReceiver.handle and adapter steps. The
 * WebSocketBridgeServer.routeMessage catch block recognizes this class
 * and forwards `code` + `message` verbatim into submitError, instead of
 * swallowing into the generic 'rejected'.
 */
export class BridgeReceiverError extends Error {
  constructor(
    public readonly code: BridgeErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'BridgeReceiverError'
  }
}
