import { EventEmitter } from 'node:events'
import { Events } from '@shared/protocol/events'
import { describe, expect, it } from 'vitest'
import { bindEventBroadcaster } from './events'

describe('bindEventBroadcaster', () => {
  it('forwards eventBus emissions to registered sockets', () => {
    const bus = new EventEmitter()
    const sent: unknown[] = []
    const fakeSocket = { send: (msg: string) => sent.push(JSON.parse(msg)) }
    const broadcaster = bindEventBroadcaster(bus as never)
    broadcaster.register(fakeSocket as never)

    bus.emit(Events.TaskUpdated, { id: 't1' })

    expect(sent).toEqual([
      { channel: Events.TaskUpdated, args: [{ id: 't1' }] },
    ])
  })

  it('stops sending after unregister', () => {
    const bus = new EventEmitter()
    const sent: unknown[] = []
    const fakeSocket = { send: (msg: string) => sent.push(JSON.parse(msg)) }
    const broadcaster = bindEventBroadcaster(bus as never)
    broadcaster.register(fakeSocket as never)
    broadcaster.unregister(fakeSocket as never)
    bus.emit(Events.TaskUpdated, { id: 't2' })
    expect(sent).toEqual([])
  })
})
