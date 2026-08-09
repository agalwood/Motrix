import type { CommandChannel } from './commands'
import type { QueryChannel } from './queries'

// biome-ignore lint/suspicious/noExplicitAny: handler args accept narrower signatures via contravariance
export type Handler = (...args: any[]) => Promise<unknown>
export type CommandHandlerMap = Partial<Record<CommandChannel, Handler>>
export type QueryHandlerMap = Partial<Record<QueryChannel, Handler>>

export type CommandInvoker = (
  channel: CommandChannel,
  ...args: unknown[]
) => Promise<unknown>

export type QueryInvoker = (
  channel: QueryChannel,
  ...args: unknown[]
) => Promise<unknown>
