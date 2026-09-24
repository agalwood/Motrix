// @vitest-environment node
import { EventEmitter } from 'node:events'
import { WEB_EVENT_HEARTBEAT } from '@shared/schemas/web-event-stream'
import { afterEach, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { bindEventHeartbeat } from './event-heartbeat'

afterEach(() => vi.useRealTimers())

it('advertises liveness, accepts control pongs, and terminates an unresponsive peer', () => {
  vi.useFakeTimers()
  const socket = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    ping: vi.fn(),
    terminate: vi.fn(),
  })
  const dispose = bindEventHeartbeat(socket as unknown as WebSocket)
  expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual(WEB_EVENT_HEARTBEAT)
  vi.advanceTimersByTime(30_000)
  socket.emit('pong')
  vi.advanceTimersByTime(30_000)
  expect(socket.terminate).not.toHaveBeenCalled()
  vi.advanceTimersByTime(15_000)
  expect(socket.terminate).toHaveBeenCalledOnce()
  dispose()
  expect(socket.listenerCount('pong')).toBe(0)
  const count = socket.send.mock.calls.length
  vi.advanceTimersByTime(60_000)
  expect(socket.send).toHaveBeenCalledTimes(count)
})
