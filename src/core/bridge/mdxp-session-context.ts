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
   * Whether the peer may invoke control-plane / download methods.
   *
   * Every WebSocket session is authorized **at the transport**: MBP1
   * authenticates below MDXP, and `adoptAuthenticatedSession` marks the
   * connection before registering a single handler
   * (docs/bridge-pairing-protocol.md §4, §6.6, §8). The bearer-authenticated
   * unary path is likewise authorized by the time a context exists. No handler
   * grants authorization any more; `markAuthorized` remains only so a future
   * transport can promote a session it deliberately admitted unauthorized.
   */
  isAuthorized(): boolean
  markAuthorized(): void
  /**
   * Legacy pairing context from the transport. Always `null` for an MBP1
   * extension session and for unary requests: the approval dialog now lives
   * inside the `/pair` state machine, below MDXP, so no handler reads this.
   * Kept as a seam for a transport that must hand a handler pre-MDXP context.
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
