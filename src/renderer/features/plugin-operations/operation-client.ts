import { transport } from '@renderer/lib/transport'
import type { CommandChannel } from '@shared/protocol/commands'
/** Operation responses originate in the shared, validating host service. */
export async function invokeOperation<T>(
  channel: CommandChannel,
  ...args: unknown[]
): Promise<T> {
  return (await transport.invoke(channel, ...args)) as T
}
