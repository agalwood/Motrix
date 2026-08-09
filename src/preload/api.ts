import type { CommandChannel } from '../shared/protocol/commands'
import type { EventChannel } from '../shared/protocol/events'
import type { QueryChannel } from '../shared/protocol/queries'

export interface MotrixAPI {
  invoke(
    channel: CommandChannel | QueryChannel,
    ...args: unknown[]
  ): Promise<unknown>
  on(channel: EventChannel, callback: (...args: unknown[]) => void): void
  off(channel: EventChannel, callback: (...args: unknown[]) => void): void
  platform: NodeJS.Platform
  // Electron 32+ removed File.path; webUtils.getPathForFile resolves the
  // absolute path of a File obtained from <input type="file"> or drag-drop.
  getPathForFile(file: File): string
}
