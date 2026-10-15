import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useControlPanel } from '@/popup/useControlPanel'
import { CONTROL_PANEL_ACTIVITY_EVENT } from '@/shared/controlPanelEvents'

declare const browser: {
  runtime: {
    sendMessage: (msg: unknown) => Promise<unknown>
    onMessage: {
      addListener: (listener: (message: unknown) => void) => void
      removeListener: (listener: (message: unknown) => void) => void
    }
  }
}

type Envelope = { kind: string; payload: unknown }
type RuntimeMessageListener = (message: unknown) => void

let runtimeMessageListeners: RuntimeMessageListener[] = []

function emitRuntimeMessage(message: unknown): void {
  for (const listener of runtimeMessageListeners) listener(message)
}

function mockBus(): { sent: Envelope[] } {
  const sent: Envelope[] = []
  browser.runtime.sendMessage = vi.fn(async (msg: unknown) => {
    const env = msg as Envelope
    sent.push(env)
    if (env.kind === 'bg.taskList')
      return {
        tasks: [
          {
            id: 't1',
            type: 'http',
            name: 'a.bin',
            status: 'downloading',
            progress: 0.5,
            bytesDone: 5,
            bytesTotal: 10,
            speedBps: 100,
            etaSec: 1,
            saveDir: '/d',
            error: null,
            createdAt: 0,
            finishedAt: null,
            finalPath: null,
          },
        ],
        total: 1,
      }
    if (env.kind === 'bg.statsGet')
      return {
        totalDownloadSpeed: 100,
        totalUploadSpeed: 0,
        activeTasks: 1,
        waitingTasks: 0,
        stoppedTasks: 0,
      }
    if (env.kind === 'bg.engineStatus')
      return { state: 'ready', featureReport: null }
    return { ok: true }
  })
  return { sent }
}

describe('useControlPanel', () => {
  beforeEach(() => {
    vi.useRealTimers()
    runtimeMessageListeners = []
    browser.runtime.onMessage.addListener = vi.fn((listener) => {
      runtimeMessageListeners.push(listener)
    })
    browser.runtime.onMessage.removeListener = vi.fn((listener) => {
      runtimeMessageListeners = runtimeMessageListeners.filter(
        (candidate) => candidate !== listener
      )
    })
  })

  it('loads tasks, stats and engine status', async () => {
    mockBus()
    const { result } = renderHook(() => useControlPanel(true))
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))
    expect(result.current.tasks[0]?.name).toBe('a.bin')
    expect(result.current.stats?.activeTasks).toBe(1)
    expect(result.current.engine?.state).toBe('ready')
  })

  it('reuses an unchanged controller snapshot between polls', async () => {
    vi.useFakeTimers()
    mockBus()
    const { result } = renderHook(() => useControlPanel(true))
    await vi.waitFor(() => expect(result.current.tasks).toHaveLength(1))
    const firstController = result.current
    const firstTask = result.current.tasks[0]

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })

    expect(result.current).toBe(firstController)
    expect(result.current.tasks[0]).toBe(firstTask)
  })

  it('updates stats while retaining unchanged task objects', async () => {
    vi.useFakeTimers()
    let downloadSpeed = 100
    mockBus()
    const sendMessage = browser.runtime.sendMessage as ReturnType<typeof vi.fn>
    sendMessage.mockImplementation(async (msg: unknown) => {
      const env = msg as Envelope
      if (env.kind === 'bg.taskList') {
        return {
          tasks: [
            {
              id: 't1',
              type: 'http',
              name: 'a.bin',
              status: 'downloading',
              progress: 0.5,
              bytesDone: 5,
              bytesTotal: 10,
              speedBps: 100,
              etaSec: 1,
              saveDir: '/d',
              error: null,
              createdAt: 0,
              finishedAt: null,
              finalPath: null,
            },
          ],
          total: 1,
        }
      }
      if (env.kind === 'bg.statsGet') {
        return {
          totalDownloadSpeed: downloadSpeed,
          totalUploadSpeed: 0,
          activeTasks: 1,
          waitingTasks: 0,
          stoppedTasks: 0,
        }
      }
      if (env.kind === 'bg.engineStatus') {
        return { state: 'ready', featureReport: null }
      }
      return { ok: true }
    })

    const { result } = renderHook(() => useControlPanel(true))
    await vi.waitFor(() => expect(result.current.tasks).toHaveLength(1))
    const firstTask = result.current.tasks[0]

    downloadSpeed = 200
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })

    expect(result.current.stats?.totalDownloadSpeed).toBe(200)
    expect(result.current.tasks[0]).toBe(firstTask)
  })

  it('backs off task polling when the task list is idle', async () => {
    vi.useFakeTimers()
    const sent: Envelope[] = []
    browser.runtime.sendMessage = vi.fn(async (msg: unknown) => {
      const env = msg as Envelope
      sent.push(env)
      if (env.kind === 'bg.taskList') return { tasks: [], total: 0 }
      if (env.kind === 'bg.statsGet') {
        return {
          totalDownloadSpeed: 0,
          totalUploadSpeed: 0,
          activeTasks: 0,
          waitingTasks: 0,
          stoppedTasks: 0,
        }
      }
      if (env.kind === 'bg.engineStatus') {
        return { state: 'ready', featureReport: null }
      }
      return { ok: true }
    })

    const { result } = renderHook(() => useControlPanel(true))
    await vi.waitFor(() => expect(result.current.loading).toBe(false))
    const taskReads = (): number =>
      sent.filter(({ kind }) => kind === 'bg.taskList').length

    expect(taskReads()).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000)
    })
    expect(taskReads()).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(taskReads()).toBe(2)
  })

  it('wakes an idle poll immediately when the background reports activity', async () => {
    vi.useFakeTimers()
    const sent: Envelope[] = []
    browser.runtime.sendMessage = vi.fn(async (msg: unknown) => {
      const env = msg as Envelope
      sent.push(env)
      if (env.kind === 'bg.taskList') return { tasks: [], total: 0 }
      if (env.kind === 'bg.statsGet') {
        return {
          totalDownloadSpeed: 0,
          totalUploadSpeed: 0,
          activeTasks: 0,
          waitingTasks: 0,
          stoppedTasks: 0,
        }
      }
      if (env.kind === 'bg.engineStatus') {
        return { state: 'ready', featureReport: null }
      }
      return { ok: true }
    })

    const { result } = renderHook(() => useControlPanel(true))
    await vi.waitFor(() => expect(result.current.loading).toBe(false))
    const taskReads = (): number =>
      sent.filter(({ kind }) => kind === 'bg.taskList').length
    expect(taskReads()).toBe(1)

    act(() => emitRuntimeMessage({ kind: CONTROL_PANEL_ACTIVITY_EVENT }))
    await vi.waitFor(() => expect(taskReads()).toBe(2))
  })

  it('polls engine status independently from active task progress', async () => {
    vi.useFakeTimers()
    const { sent } = mockBus()
    const { result } = renderHook(() => useControlPanel(true))
    await vi.waitFor(() => expect(result.current.tasks).toHaveLength(1))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500)
    })

    expect(sent.filter(({ kind }) => kind === 'bg.taskList')).toHaveLength(2)
    expect(sent.filter(({ kind }) => kind === 'bg.statsGet')).toHaveLength(2)
    expect(sent.filter(({ kind }) => kind === 'bg.engineStatus')).toHaveLength(
      1
    )
  })

  it('does not overlap activity refreshes when a request is slow', async () => {
    vi.useFakeTimers()
    let resolveTasks!: (value: { tasks: []; total: 0 }) => void
    const tasks = new Promise<{ tasks: []; total: 0 }>((resolve) => {
      resolveTasks = resolve
    })
    const sendMessage = vi.fn(async (msg: unknown) => {
      const env = msg as Envelope
      if (env.kind === 'bg.taskList') return tasks
      if (env.kind === 'bg.statsGet') {
        return {
          totalDownloadSpeed: 0,
          totalUploadSpeed: 0,
          activeTasks: 0,
          waitingTasks: 0,
          stoppedTasks: 0,
        }
      }
      if (env.kind === 'bg.engineStatus') {
        return { state: 'ready', featureReport: null }
      }
      return { ok: true }
    })
    browser.runtime.sendMessage = sendMessage

    renderHook(() => useControlPanel(true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(
      sendMessage.mock.calls.filter(
        ([message]) => (message as Envelope).kind === 'bg.taskList'
      )
    ).toHaveLength(1)

    resolveTasks({ tasks: [], total: 0 })
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('pause() dispatches bg.taskPause then refreshes', async () => {
    const { sent } = mockBus()
    const { result } = renderHook(() => useControlPanel(true))
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))
    await act(async () => {
      await result.current.pause('t1')
    })
    expect(sent.map((e) => e.kind)).toContain('bg.taskPause')
  })

  it('reveal() dispatches bg.taskReveal without refreshing the task list', async () => {
    const { sent } = mockBus()
    const { result } = renderHook(() => useControlPanel(true))
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))
    const readsBefore = sent.filter(({ kind }) => kind === 'bg.taskList').length

    await act(async () => {
      await result.current.reveal('t1')
    })

    expect(sent).toContainEqual({
      kind: 'bg.taskReveal',
      payload: { taskId: 't1' },
    })
    expect(sent.filter(({ kind }) => kind === 'bg.taskList')).toHaveLength(
      readsBefore
    )
  })

  it('clears cached tasks and stats while a new backend scope loads', async () => {
    let remote = false
    let resolveRemoteTasks!: (value: { tasks: []; total: 0 }) => void
    const remoteTasks = new Promise<{ tasks: []; total: 0 }>((resolve) => {
      resolveRemoteTasks = resolve
    })

    browser.runtime.sendMessage = vi.fn(async (msg: unknown) => {
      const env = msg as Envelope
      if (remote && env.kind === 'bg.taskList') return remoteTasks
      if (env.kind === 'bg.taskList') {
        return {
          tasks: [
            {
              id: 'local-task',
              type: 'http',
              name: 'local.bin',
              status: 'downloading',
              progress: 0.5,
              bytesDone: 5,
              bytesTotal: 10,
              speedBps: 100,
              etaSec: 1,
              saveDir: '/d',
              error: null,
              createdAt: 0,
              finishedAt: null,
              finalPath: null,
            },
          ],
          total: 1,
        }
      }
      if (env.kind === 'bg.statsGet') {
        return {
          totalDownloadSpeed: remote ? 200 : 100,
          totalUploadSpeed: 0,
          activeTasks: remote ? 0 : 1,
          waitingTasks: 0,
          stoppedTasks: 0,
        }
      }
      if (env.kind === 'bg.engineStatus') {
        return { state: 'ready', featureReport: null }
      }
      return { ok: true }
    })

    const { result, rerender } = renderHook(
      ({ scopeKey }) => useControlPanel(true, scopeKey),
      { initialProps: { scopeKey: 'local' } }
    )
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))
    expect(result.current.stats?.totalDownloadSpeed).toBe(100)

    remote = true
    rerender({ scopeKey: 'remote' })

    expect(result.current.tasks).toEqual([])
    expect(result.current.stats).toBeNull()
    expect(result.current.loading).toBe(true)

    resolveRemoteTasks({ tasks: [], total: 0 })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.stats?.totalDownloadSpeed).toBe(200)
  })
})

it('keeps the last good snapshot while paused, stops polling, and clears it when the backend changes', async () => {
  vi.useFakeTimers()
  const { sent } = mockBus()
  const { result, rerender, unmount } = renderHook(
    ({ paused, scope }) => useControlPanel(true, scope, paused),
    { initialProps: { paused: false, scope: 'local' } }
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(result.current.tasks).toHaveLength(1)
  rerender({ paused: true, scope: 'local' })
  const requests = sent.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000)
    await result.current.refresh()
  })
  expect(sent).toHaveLength(requests)
  expect(result.current.tasks).toHaveLength(1)
  expect(result.current.stats?.totalDownloadSpeed).toBe(100)
  await expect(result.current.pause('t1')).rejects.toThrow('needs retry')
  rerender({ paused: true, scope: 'remote' })
  expect(result.current.tasks).toEqual([])
  expect(result.current.stats).toBeNull()
  unmount()
  vi.useRealTimers()
})

it('accepts fresh statistics independently of a stalled task request', async () => {
  vi.useRealTimers()
  mockBus()
  const original = browser.runtime.sendMessage
  let rejectList: ((error: Error) => void) | undefined
  browser.runtime.sendMessage = vi.fn((message) =>
    (message as Envelope).kind === 'bg.taskList'
      ? new Promise((_resolve, reject) => {
          rejectList = reject
        })
      : original(message)
  )
  const { result, unmount } = renderHook(() => useControlPanel(true))
  await waitFor(() =>
    expect(result.current.stats?.totalDownloadSpeed).toBe(100)
  )
  await act(async () => {
    rejectList?.(new Error('list timeout'))
  })
  expect(result.current.error).toBe('list timeout')
  expect(result.current.stats?.totalDownloadSpeed).toBe(100)
  unmount()
})
