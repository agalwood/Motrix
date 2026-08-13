import type {
  BridgeCommand,
  BridgeEvent,
  BridgeQuery,
} from '../shared/protocol/bridge'
import type { CommandChannel } from '../shared/protocol/commands'
import type { EventChannel, Events } from '../shared/protocol/events'
import type { QueryChannel } from '../shared/protocol/queries'

export type PluginLogEventChannel = `${typeof Events.PluginLog}:${string}`
export type RendererInvokeChannel =
  | CommandChannel
  | QueryChannel
  | BridgeCommand
  | BridgeQuery
export type RendererEventChannel =
  | EventChannel
  | BridgeEvent
  | PluginLogEventChannel

export interface MotrixAPI {
  invoke(channel: RendererInvokeChannel, ...args: unknown[]): Promise<unknown>
  on(
    channel: RendererEventChannel,
    callback: (...args: unknown[]) => void
  ): void
  off(
    channel: RendererEventChannel,
    callback: (...args: unknown[]) => void
  ): void
  platform: NodeJS.Platform
  // Electron 32+ removed File.path; webUtils.getPathForFile resolves the
  // absolute path of a File obtained from <input type="file"> or drag-drop.
  getPathForFile(file: File): string
}
