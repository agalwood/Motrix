import { parseProtocolEnvelope } from '@shared/protocol/errors'
import type { EventChannel } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { AnyChannel, EventListener, Transport } from './types'

function getMotrix(): NonNullable<Window['motrix']> {
  if (!window.motrix) {
    throw new Error('Preload not initialized: window.motrix is undefined')
  }
  return window.motrix
}

export class ElectronTransport implements Transport {
  get platform(): NodeJS.Platform | 'web' {
    return window.motrix?.platform ?? 'web'
  }
  async invoke(channel: AnyChannel, ...args: unknown[]): Promise<unknown> {
    const value = await getMotrix().invoke(channel, ...args)
    return channel === Queries.GetTaskInspectorActivity
      ? parseProtocolEnvelope(value)
      : value
  }
  on(channel: EventChannel, cb: EventListener): void {
    getMotrix().on(channel, cb)
  }
  off(channel: EventChannel, cb: EventListener): void {
    getMotrix().off(channel, cb)
  }
}
