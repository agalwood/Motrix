export type RpcMessageHandler = (data: string) => void
export type RpcCloseHandler = (code: number, reason: string) => void
export type RpcErrorHandler = (err: Error) => void

/**
 * Bidirectional JSON-RPC carrier used by {@link JsonRpcProtocol}.
 *
 * `send` is fire-and-forget: matching responses arrive later through
 * `onMessage`. HTTP implementations POST each payload and deliver the
 * response body as a single message. WebSocket implementations forward
 * frames in both directions, including server-initiated notifications.
 */
export interface RpcTransport {
  connect(url: string): Promise<void>
  disconnect(): void
  isConnected(): boolean
  send(data: string): void
  onMessage(handler: RpcMessageHandler): void
  onClose(handler: RpcCloseHandler): void
  onError(handler: RpcErrorHandler): void
}
