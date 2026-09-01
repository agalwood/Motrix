// Installs the vscode-jsonrpc v9 Node runtime abstraction layer (RAL) into the
// same vscode-jsonrpc instance mdxp's createMdxpConnection uses. Required before
// any MessageConnection.listen(); side-effect import, kept adjacent to the
// createMdxpConnection import below. Both Node shells (Electron main + server)
// route mdxp connections through this module, so this is the single install
// point. The browser extension uses '@motrix/mdxp/browser' instead.
import '@motrix/mdxp/node'
import { createMdxpConnection, type MdxpConnection } from '@motrix/mdxp'
import type { Browser } from '@shared/protocol/bridge'
import {
  type WebSocketLike,
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from './web-socket-message-stream'

// Re-export so existing `import { Browser } from './bridge-connection'` sites
// keep resolving; the canonical declaration now lives in @shared/protocol.
export type { Browser } from '@shared/protocol/bridge'

export interface BridgeSessionMeta {
  /** `${browser}:${extensionId}`, used as the session map key. */
  sessionKey: string
  extensionId: string
  browser: Browser
  startedAt: number
}

/**
 * Per-WebSocket-connection wrapper around `MdxpConnection`. Owns the
 * reader/writer pair and exposes a typed handler API plus session
 * metadata.
 *
 * Lifecycle:
 *   1. constructor(ws, meta) — instantiate streams + MdxpConnection
 *   2. caller registers `onRequest`/`onNotification` handlers
 *   3. caller calls `listen()` exactly once to start processing inbound
 *   4. server-side code calls `sendRequest`/`sendNotification` as needed
 *   5. caller (or close event) calls `dispose()` once
 */
export class BridgeConnection {
  private readonly reader: WebSocketMessageReader
  private readonly writer: WebSocketMessageWriter
  private readonly mdxp: MdxpConnection
  private listened = false
  private disposed = false
  private ready = false
  // Authorization is separate from `ready`: `ready` means the peer sent
  // `motrix/initialized`; `authorized` means the peer is permitted to drive
  // control-plane / download methods. A `/v1` reconnect is authorized on
  // connect (its pair token was already verified at upgrade); a `/pair`
  // first-connect starts UNauthorized and is promoted only after the
  // initialize handler records a pairing approval.
  private authorized = false

  constructor(
    ws: WebSocketLike,
    public readonly session: BridgeSessionMeta
  ) {
    this.reader = new WebSocketMessageReader(ws)
    this.writer = new WebSocketMessageWriter(ws)
    this.mdxp = createMdxpConnection(this.reader, this.writer)
  }

  get sessionKey(): string {
    return this.session.sessionKey
  }

  isReady(): boolean {
    return this.ready
  }

  markReady(): void {
    this.ready = true
  }

  isAuthorized(): boolean {
    return this.authorized
  }

  markAuthorized(): void {
    this.authorized = true
  }

  /**
   * Irreversibly cut off this live session before its WebSocket drains.
   * Revocation notifications are best-effort and may need a short flush
   * window, but inbound control-plane dispatch and outbound ready-session
   * selection must stop immediately.
   */
  revokeAuthorization(): void {
    this.authorized = false
    this.ready = false
  }

  /** Begin processing inbound frames. Call AFTER registering handlers. */
  listen(): void {
    if (this.listened) return
    this.listened = true
    this.mdxp.listen()
  }

  /** Register a typed request handler. */
  onRequest: MdxpConnection['onRequest'] = (method, handler) => {
    this.mdxp.onRequest(method, handler)
  }

  /** Register a typed notification handler. */
  onNotification: MdxpConnection['onNotification'] = (name, handler) => {
    this.mdxp.onNotification(name, handler)
  }

  /** Send a typed request to the peer. */
  sendRequest: MdxpConnection['sendRequest'] = (method, params, token) => {
    return this.mdxp.sendRequest(method, params, token)
  }

  /** Send a typed notification to the peer. */
  sendNotification: MdxpConnection['sendNotification'] = (name, params) => {
    // Notifications are best-effort by JSON-RPC definition. The typed MDXP
    // wrapper intentionally exposes a void return, while vscode-jsonrpc's raw
    // writer returns a Promise that rejects if the socket closes between
    // session lookup and write. Always observe that Promise here so a routine
    // disconnect/revoke cannot become an unhandled process rejection.
    try {
      const pending =
        params === undefined
          ? this.mdxp.raw.sendNotification(name as string)
          : this.mdxp.raw.sendNotification(name as string, params)
      void pending.catch(() => {})
    } catch {
      // The connection may already be disposed. There is no request id to
      // retry or report, and a later session must never receive this event.
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.mdxp.dispose()
    this.reader.dispose()
    this.writer.dispose()
  }
}
