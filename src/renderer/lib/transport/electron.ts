import { Commands } from '@shared/protocol/commands'
import { parseProtocolEnvelope } from '@shared/protocol/errors'
import type { EventChannel } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { rendererSessionSchema } from '@shared/schemas/renderer-health'
import { rendererSubmissionChannelSchema } from '@shared/schemas/renderer-submission'
import { registerIntentConsumer } from '../renderer-intents'
import type { AnyChannel, EventListener, Transport } from './types'

function getMotrix(): NonNullable<Window['motrix']> {
  if (!window.motrix) {
    throw new Error('Preload not initialized: window.motrix is undefined')
  }
  return window.motrix
}

export class ElectronTransport implements Transport {
  private readonly subscriptions = new Map<
    EventListener,
    Map<EventChannel, () => void>
  >()
  get platform(): NodeJS.Platform | 'web' {
    return window.motrix?.platform ?? 'web'
  }
  async invoke(channel: AnyChannel, ...args: unknown[]): Promise<unknown> {
    if (rendererSubmissionChannelSchema.safeParse(channel).success) {
      const session = rendererSessionSchema.parse(
        await getMotrix().invoke(Queries.GetRendererSession)
      )
      return getMotrix().invoke(Commands.ExecuteRendererSubmission, {
        id: crypto.randomUUID(),
        generation: session.generation,
        channel,
        args,
      })
    }
    const value = await getMotrix().invoke(channel, ...args)
    return channel === Queries.GetTaskInspectorActivity ||
      channel === Commands.OpenTaskFile
      ? parseProtocolEnvelope(value)
      : value
  }
  on(channel: EventChannel, cb: EventListener): void {
    let channels = this.subscriptions.get(cb)
    if (channels?.has(channel)) return
    const unsubscribe = getMotrix().on(channel, cb)
    if (!channels) {
      channels = new Map()
      this.subscriptions.set(cb, channels)
    }
    const unregisterIntent = registerIntentConsumer(channel, cb)
    channels.set(channel, () => {
      unsubscribe?.()
      unregisterIntent()
    })
  }
  off(channel: EventChannel, cb: EventListener): void {
    const channels = this.subscriptions.get(cb)
    channels?.get(channel)?.()
    channels?.delete(channel)
    if (!channels?.size) this.subscriptions.delete(cb)
  }
}
