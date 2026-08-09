import type { MdxpConnection } from '@motrix/mdxp'
import type { ClientIdentity } from '@shared/protocol/bridge'
import type { BridgeConnection } from './bridge-connection'
import type { PairRequestArgs } from './web-socket-bridge-server'

/**
 * Transport-neutral per-request context handed to every MDXP method handler.
 *
 * This is the seam that decouples handlers from a concrete `BridgeConnection`:
 * a live WebSocket session supplies the duplex `sendRequest`/`sendNotification`
 * functions, while a future stateless unary transport (Spec 3) synthesizes a
 * context with those omitted and `pendingPair: null`.
 */
export interface MdxpSessionContext {
  /** Who the peer is. Spec 1 only ever produces the `extension` kind. */
  readonly identity: ClientIdentity
  readonly startedAt: number
  isReady(): boolean
  markReady(): void
  /**
   * Whether the peer may invoke control-plane / download methods. `/v1`
   * reconnects and the bearer-authenticated unary path are authorized; a
   * `/pair` first-connect is authorized only after the initialize handler
   * records a pairing approval via `markAuthorized`.
   */
  isAuthorized(): boolean
  markAuthorized(): void
  /**
   * Pairing context from the transport: a first-pair connection (`/pair`)
   * carries `PairRequestArgs`; reconnect (`/v1`) and unary requests carry
   * `null`. Only `motrix/initialize` reads it.
   */
  readonly pendingPair: PairRequestArgs | null
  /**
   * Duplex outbound — present for live WebSocket sessions, omitted for the
   * stateless unary path. Server-initiated callers (e.g. UrlResolutionService)
   * must guard on presence.
   */
  readonly sendRequest?: MdxpConnection['sendRequest']
  readonly sendNotification?: MdxpConnection['sendNotification']
}

/** Adapt a live `BridgeConnection` (+ its pairing context) into a context. */
export function contextFromConnection(
  conn: BridgeConnection,
  pendingPair: PairRequestArgs | null
): MdxpSessionContext {
  return {
    identity: {
      kind: 'extension',
      browser: conn.session.browser,
      extensionId: conn.session.extensionId,
    },
    startedAt: conn.session.startedAt,
    isReady: () => conn.isReady(),
    markReady: () => conn.markReady(),
    isAuthorized: () => conn.isAuthorized(),
    markAuthorized: () => conn.markAuthorized(),
    pendingPair,
    sendRequest: conn.sendRequest,
    sendNotification: conn.sendNotification,
  }
}
