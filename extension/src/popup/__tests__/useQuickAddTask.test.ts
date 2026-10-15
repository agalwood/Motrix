import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTaskOptions } from '@/shared/taskOptions'

vi.mock('@/background/MessageBus', () => ({ send: vi.fn() }))

import * as MessageBus from '@/background/MessageBus'
import {
  QUICK_ADD_TASK_SESSION_KEY,
  useQuickAddTask,
} from '@/popup/useQuickAddTask'

const send = vi.mocked(MessageBus.send)

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('useQuickAddTask', () => {
  beforeEach(() => {
    send.mockReset()
  })

  it('rejects invalid input locally without contacting the background', async () => {
    const onCreated = vi.fn()
    const { result } = renderHook(() => useQuickAddTask({ onCreated }))

    act(() => result.current.setInput('ftp://example.com/file.zip'))
    await act(async () => {
      expect(await result.current.submit()).toBeNull()
    })

    expect(result.current.error).toBe('unsupported')
    expect(send).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('normalizes input, creates a task, then clears the logical submission', async () => {
    send.mockResolvedValue({ taskId: 'task-1' })
    const onCreated = vi.fn()
    const { result } = renderHook(() => useQuickAddTask({ onCreated }))

    act(() => result.current.setInput('  https://example.com/a file.zip  '))
    await act(async () => {
      expect(await result.current.submit()).toBe('task-1')
    })

    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(send).toHaveBeenCalledWith('bg.createManualTask', {
      input: 'https://example.com/a%20file.zip',
      idempotencyKey: expect.any(String),
      options: defaultTaskOptions(navigator.userAgent),
    })
    expect(onCreated).toHaveBeenCalledWith('task-1')
    expect(result.current.input).toBe('')
    expect(result.current.error).toBeNull()
    expect(result.current.submitting).toBe(false)
  })

  it('keeps the input and idempotency key when a failed request is retried', async () => {
    send
      .mockRejectedValueOnce(new Error('native path: /secret/download'))
      .mockResolvedValueOnce({ taskId: 'task-retried' })
    const onCreated = vi.fn()
    const { result } = renderHook(() => useQuickAddTask({ onCreated }))

    act(() => result.current.setInput('magnet:?xt=urn:btih:ABC123'))
    await act(async () => {
      expect(await result.current.submit()).toBeNull()
    })

    expect(result.current.input).toBe('magnet:?xt=urn:btih:ABC123')
    expect(result.current.error).toBe('submitFailed')
    const firstKey = (send.mock.calls[0][1] as { idempotencyKey: string })
      .idempotencyKey

    await act(async () => {
      expect(await result.current.submit()).toBe('task-retried')
    })

    const retryKey = (send.mock.calls[1][1] as { idempotencyKey: string })
      .idempotencyKey
    expect(retryKey).toBe(firstKey)
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it('starts a new logical submission after the user edits failed input', async () => {
    send
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ taskId: 'task-2' })
    const { result } = renderHook(() => useQuickAddTask({ onCreated: vi.fn() }))

    act(() => result.current.setInput('https://example.com/one.zip'))
    await act(async () => {
      await result.current.submit()
    })
    const failedKey = (
      send.mock.calls[0][1] as {
        idempotencyKey: string
      }
    ).idempotencyKey

    act(() => result.current.setInput('https://example.com/two.zip'))
    expect(result.current.error).toBeNull()
    await act(async () => {
      await result.current.submit()
    })
    const editedKey = (
      send.mock.calls[1][1] as {
        idempotencyKey: string
      }
    ).idempotencyKey

    expect(editedKey).not.toBe(failedKey)
  })

  it('coalesces repeated submits while one request is in flight', async () => {
    const pending = deferred<{ taskId: string }>()
    send.mockImplementation(() => pending.promise)
    const onCreated = vi.fn()
    const { result } = renderHook(() => useQuickAddTask({ onCreated }))

    act(() => result.current.setInput('https://example.com/file.zip'))

    let first!: Promise<string | null>
    let repeated!: Promise<string | null>
    act(() => {
      first = result.current.submit()
      repeated = result.current.submit()
    })

    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    await expect(repeated).resolves.toBeNull()

    pending.resolve({ taskId: 'task-pending' })
    await act(async () => {
      await first
    })
    expect(onCreated).toHaveBeenCalledWith('task-pending')
  })

  it('restores a lost-ack submission after unmount and retries with the same key', async () => {
    const lostAcknowledgement = deferred<{ taskId: string }>()
    send
      .mockImplementationOnce(() => lostAcknowledgement.promise)
      .mockResolvedValueOnce({ taskId: 'task-recovered' })

    const first = renderHook(() => useQuickAddTask({ onCreated: vi.fn() }))
    act(() =>
      first.result.current.setInput(' https://example.com/lost ack.zip ')
    )
    act(() => {
      void first.result.current.submit()
    })

    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    const firstRequest = send.mock.calls[0]?.[1] as {
      input: string
      idempotencyKey: string
    }
    expect(firstRequest.input).toBe('https://example.com/lost%20ack.zip')
    expect(
      (await chrome.storage.session.get(QUICK_ADD_TASK_SESSION_KEY))[
        QUICK_ADD_TASK_SESSION_KEY
      ]
    ).toEqual({
      normalizedInput: firstRequest.input,
      idempotencyKey: firstRequest.idempotencyKey,
      options: defaultTaskOptions(navigator.userAgent),
    })

    // Simulate the popup disappearing after the request was sent but before
    // its acknowledgement arrived. The unresolved request deliberately stays
    // unresolved, as it would when the popup execution context is destroyed.
    first.unmount()

    const onCreated = vi.fn()
    const reopened = renderHook(() => useQuickAddTask({ onCreated }))
    await waitFor(() =>
      expect(reopened.result.current.input).toBe(firstRequest.input)
    )

    await act(async () => {
      expect(await reopened.result.current.submit()).toBe('task-recovered')
    })

    const retriedRequest = send.mock.calls[1]?.[1] as {
      input: string
      idempotencyKey: string
    }
    expect(retriedRequest.idempotencyKey).toBe(firstRequest.idempotencyKey)
    expect(onCreated).toHaveBeenCalledWith('task-recovered')
    expect(
      (await chrome.storage.session.get(QUICK_ADD_TASK_SESSION_KEY))[
        QUICK_ADD_TASK_SESSION_KEY
      ]
    ).toBeUndefined()
  })

  it('does not let late hydration overwrite input entered by the user', async () => {
    let resolveGet!: (value: Record<string, unknown>) => void
    const delayedGet = new Promise<Record<string, unknown>>((resolve) => {
      resolveGet = resolve
    })
    const originalGet = chrome.storage.session.get
    chrome.storage.session.get = vi.fn(() => delayedGet)

    const { result } = renderHook(() => useQuickAddTask({ onCreated: vi.fn() }))
    act(() => result.current.setInput('https://example.com/newer.zip'))

    resolveGet({
      [QUICK_ADD_TASK_SESSION_KEY]: {
        normalizedInput: 'https://example.com/stale.zip',
        idempotencyKey: 'stale-key-123',
      },
    })
    await act(async () => {
      await delayedGet
    })

    expect(result.current.input).toBe('https://example.com/newer.zip')
    chrome.storage.session.get = originalGet
  })

  it('falls back to in-memory retry when session storage fails', async () => {
    const originalSet = chrome.storage.session.set
    chrome.storage.session.set = vi.fn(async () => {
      throw new Error('storage unavailable')
    })
    send
      .mockRejectedValueOnce(new Error('lost connection'))
      .mockResolvedValueOnce({ taskId: 'task-without-storage' })

    const onCreated = vi.fn()
    const { result } = renderHook(() => useQuickAddTask({ onCreated }))
    act(() => result.current.setInput('https://example.com/fallback.zip'))

    await act(async () => {
      expect(await result.current.submit()).toBeNull()
    })
    const firstKey = (send.mock.calls[0][1] as { idempotencyKey: string })
      .idempotencyKey

    await act(async () => {
      expect(await result.current.submit()).toBe('task-without-storage')
    })
    expect(
      (send.mock.calls[1][1] as { idempotencyKey: string }).idempotencyKey
    ).toBe(firstKey)
    expect(onCreated).toHaveBeenCalledWith('task-without-storage')

    chrome.storage.session.set = originalSet
  })
})

it('keeps edited request options on retry and changes identity when those options change', async () => {
  send.mockRejectedValue(new Error('failed'))
  const { result } = renderHook(() => useQuickAddTask({ onCreated: vi.fn() }))
  act(() => {
    result.current.setInput('https://example.com/file.zip')
    result.current.setOptions({
      ...result.current.options,
      filename: 'chosen.zip',
      userAgent: 'Edited UA',
    })
  })
  await act(async () => {
    await result.current.submit()
  })
  const first = send.mock.calls.at(-1)?.[1]
  await act(async () => {
    await result.current.submit()
  })
  expect(send.mock.calls.at(-1)?.[1]).toEqual(first)
  act(() =>
    result.current.setOptions({
      ...result.current.options,
      filename: 'different.zip',
    })
  )
  await act(async () => {
    await result.current.submit()
  })
  expect(send.mock.calls.at(-1)?.[1]).not.toEqual(first)
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
    options: { filename: 'different.zip', userAgent: 'Edited UA' },
  })
})
