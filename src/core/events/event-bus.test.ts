import { Events } from '@shared/protocol/events'
import { describe, expect, it, vi } from 'vitest'
import { EventBus } from './event-bus'

describe('EventBus', () => {
  it('isolates a throwing listener so the next listener on the same channel still runs', () => {
    const bus = new EventBus()
    const second = vi.fn()

    bus.on(Events.TaskUpdated, () => {
      throw new Error('boom')
    })
    bus.on(Events.TaskUpdated, second)

    bus.emit(Events.TaskUpdated, 'payload')

    expect(second).toHaveBeenCalledWith('payload')
  })

  it('never throws out of emit even when every listener throws', () => {
    const bus = new EventBus()
    bus.on(Events.TaskUpdated, () => {
      throw new Error('first')
    })
    bus.on(Events.TaskUpdated, () => {
      throw new Error('second')
    })

    expect(() => bus.emit(Events.TaskUpdated)).not.toThrow()
  })

  it('calls onListenerError once per throwing listener with (channel, err)', () => {
    const onListenerError = vi.fn()
    const bus = new EventBus({ onListenerError })
    const err1 = new Error('first')
    const err2 = new Error('second')

    bus.on(Events.TaskUpdated, () => {
      throw err1
    })
    bus.on(Events.TaskUpdated, () => {
      throw err2
    })

    bus.emit(Events.TaskUpdated)

    expect(onListenerError).toHaveBeenCalledTimes(2)
    expect(onListenerError).toHaveBeenNthCalledWith(1, Events.TaskUpdated, err1)
    expect(onListenerError).toHaveBeenNthCalledWith(2, Events.TaskUpdated, err2)
  })

  it('swallows listener errors silently when no onListenerError option is given', () => {
    const bus = new EventBus()
    const second = vi.fn()

    bus.on(Events.TaskUpdated, () => {
      throw new Error('boom')
    })
    bus.on(Events.TaskUpdated, second)

    expect(() => bus.emit(Events.TaskUpdated)).not.toThrow()
    expect(second).toHaveBeenCalled()
  })
})
