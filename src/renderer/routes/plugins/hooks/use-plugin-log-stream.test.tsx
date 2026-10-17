import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import type { PluginLogEntry } from '@shared/types/plugin'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginLogStream } from './use-plugin-log-stream'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    onConnectionChange: vi.fn(),
  },
}))
const entry = (entryId: string): PluginLogEntry => ({
  entryId,
  ts: 123,
  level: 'error',
  msg: entryId,
})
const emit = (pluginId: string, value: PluginLogEntry) => {
  const callback = vi
    .mocked(transport.on)
    .mock.calls.findLast(
      ([channel]) => channel === `${Events.PluginLog}:${pluginId}`
    )?.[1]
  callback?.(value)
}
beforeEach(() => vi.clearAllMocks())

describe('plugin log history and live stream', () => {
  it.each([false, true])(
    'keeps a burst in order when snapshot overlaps live records (equal timestamps: %s)',
    async (equalTimestamps) => {
      let resolve!: (entries: PluginLogEntry[]) => void
      vi.mocked(transport.invoke).mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      const { result } = renderHook(() => usePluginLogStream('alice.demo'))
      const entries = Array.from({ length: 150 }, (_, index) => ({
        ...entry(String(index)),
        ts: equalTimestamps ? 1 : 1000 + index,
        logSequence: index + 1,
      }))
      act(() => {
        for (const item of entries) emit('alice.demo', item)
      })
      await act(async () => resolve(entries.slice(-100)))
      expect(result.current.entries).toEqual(entries)
    }
  )

  it('retains the newest records when delayed live delivery and snapshot exceed the cap', async () => {
    let resolve!: (entries: PluginLogEntry[]) => void
    vi.mocked(transport.invoke).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const { result } = renderHook(() => usePluginLogStream('alice.demo'))
    const entries = Array.from({ length: 600 }, (_, index) => ({
      ...entry(String(index)),
      ts: 10000 - index,
      logSequence: index + 1,
    }))
    act(() => {
      for (const item of entries.slice(0, 500)) emit('alice.demo', item)
    })
    await act(async () => resolve(entries.slice(-100)))
    expect(result.current.entries).toEqual(entries.slice(-500))
  })
  it('subscribes before loading history and merges concurrent entries exactly once', async () => {
    let resolve!: (value: PluginLogEntry[]) => void
    vi.mocked(transport.invoke).mockImplementation(() => {
      expect(transport.on).toHaveBeenCalled()
      return new Promise((done) => {
        resolve = done
      })
    })
    const { result, unmount } = renderHook(() =>
      usePluginLogStream('alice.demo')
    )
    act(() => emit('alice.demo', entry('live')))
    await act(async () => resolve([entry('history'), entry('live')]))
    expect(result.current.entries.map((e) => e.entryId)).toEqual([
      'history',
      'live',
    ])
    unmount()
    expect(transport.off).toHaveBeenCalledWith(
      `${Events.PluginLog}:alice.demo`,
      expect.any(Function)
    )
  })

  it('ignores stale snapshots and events when switching plugins', async () => {
    let resolve!: (value: PluginLogEntry[]) => void
    vi.mocked(transport.invoke)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      .mockResolvedValue([entry('bob')])
    const { result, rerender } = renderHook(
      ({ id }) => usePluginLogStream(id),
      { initialProps: { id: 'alice.demo' } }
    )
    rerender({ id: 'bob.demo' })
    await waitFor(() => expect(result.current.entries).toEqual([entry('bob')]))
    await act(async () => {
      resolve([entry('alice')])
      emit('alice.demo', entry('old-live'))
    })
    expect(result.current.entries).toEqual([entry('bob')])
  })

  it('refreshes after clearing and reconnecting without retaining old entries', async () => {
    vi.mocked(transport.invoke).mockResolvedValue([entry('old')])
    const { result } = renderHook(() => usePluginLogStream('alice.demo'))
    await waitFor(() => expect(result.current.entries).toEqual([entry('old')]))
    vi.mocked(transport.invoke).mockResolvedValue([])
    await act(() => result.current.refresh())
    expect(result.current.entries).toEqual([])
    vi.mocked(transport.invoke).mockResolvedValue([entry('after-reconnect')])
    const connected = vi.mocked(transport.onConnectionChange!).mock.calls[0][0]
    await act(async () => connected({ state: 'connected' }))
    expect(result.current.entries).toEqual([entry('after-reconnect')])
  })
})
