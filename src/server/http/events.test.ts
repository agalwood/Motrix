import { EventEmitter } from 'node:events'
import { Events } from '@shared/protocol/events'
import {
  getHiddenNotificationKinds,
  NotificationKinds,
} from '@shared/types/notification'
import { describe, expect, it } from 'vitest'
import { bindEventBroadcaster } from './events'

describe('bindEventBroadcaster', () => {
  it('applies live notification preferences while preserving application alerts and refresh events', () => {
    const bus = new EventEmitter()
    const preferences = {
      notifyInAppOnComplete: false,
      notifyInAppOnError: false,
    }
    const sent: unknown[] = []
    const broadcaster = bindEventBroadcaster(bus as never, () =>
      getHiddenNotificationKinds(preferences)
    )
    broadcaster.register({ send: (message) => sent.push(JSON.parse(message)) })
    for (const kind of [
      NotificationKinds.TaskComplete,
      NotificationKinds.TaskError,
      NotificationKinds.EngineFailure,
    ]) {
      bus.emit(Events.NotificationAdded, { kind })
    }
    bus.emit(Events.NotificationsChanged)
    expect(sent).toEqual([
      {
        channel: Events.NotificationAdded,
        args: [{ kind: NotificationKinds.EngineFailure }],
      },
      { channel: Events.NotificationsChanged, args: [] },
    ])
    preferences.notifyInAppOnComplete = true
    bus.emit(Events.NotificationAdded, { kind: NotificationKinds.TaskComplete })
    expect(sent.at(-1)).toEqual({
      channel: Events.NotificationAdded,
      args: [{ kind: NotificationKinds.TaskComplete }],
    })
  })

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
