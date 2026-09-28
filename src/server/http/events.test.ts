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
    bus.emit(Events.GeoIPStatusChanged, { enabled: true, loaded: true })

    expect(sent).toEqual([
      { channel: Events.TaskUpdated, args: [{ id: 't1' }] },
      {
        channel: Events.GeoIPStatusChanged,
        args: [{ enabled: true, loaded: true }],
      },
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

it('unregisters a socket after an asynchronous send failure', () => {
  const bus = new EventEmitter()
  let fail: ((error?: Error) => void) | undefined
  let terminated = false
  const socket = {
    send: (_data: string, callback?: (error?: Error) => void) => {
      fail = callback
    },
    terminate: () => {
      terminated = true
    },
  }
  const broadcaster = bindEventBroadcaster(bus as never)
  broadcaster.register(socket)
  bus.emit(Events.TaskUpdated, [])
  fail?.(new Error('write failed'))
  expect(broadcaster.count()).toBe(0)
  expect(terminated).toBe(true)
})
