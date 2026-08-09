import type { CommandChannel } from '@shared/protocol/commands'
import type { EventChannel } from '@shared/protocol/events'
import type { QueryChannel } from '@shared/protocol/queries'

export type AnyChannel = CommandChannel | QueryChannel
export type EventListener = (...args: unknown[]) => void

export type TransportConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'

export interface TransportConnectionEvent {
  state: TransportConnectionState
}

export type TransportConnectionListener = (
  event: TransportConnectionEvent
) => void

export interface Transport {
  invoke(channel: AnyChannel, ...args: unknown[]): Promise<unknown>
  on(channel: EventChannel, cb: EventListener): void
  off(channel: EventChannel, cb: EventListener): void
  /**
   * Optional because Electron IPC has no renderer-owned connection lifecycle.
   * Web transports return an unsubscribe function.
   */
  onConnectionChange?(cb: TransportConnectionListener): () => void
  platform: NodeJS.Platform | 'web'
}
