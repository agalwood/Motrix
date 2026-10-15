import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { send } from '@/background/MessageBus'
import { useAutoPopupReceipt } from '@/popup/useAutoPopupReceipt'
import { POPUP_RECEIPT_EVENT, type PopupReceipt } from '@/shared/autoPopup'
import { extensionBrowser as browser } from '@/shared/browser'

vi.mock('@/background/MessageBus', () => ({ send: vi.fn(async () => null) }))
afterEach(() => vi.useRealTimers())
it('refreshes on a matching receipt, rejects another endpoint, and expires the notice', async () => {
  const messages: ((message: unknown) => void)[] = []
  const port = {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn((fn) => messages.push(fn)) },
    onDisconnect: { addListener: vi.fn() },
  }
  Object.assign(browser, {
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
  })
  Object.assign(browser.runtime, { connect: vi.fn(() => port) })
  const refresh = vi.fn(async () => {})
  const { result, rerender, unmount } = renderHook(
    ({ endpoint }) => useAutoPopupReceipt(endpoint, 0, refresh),
    { initialProps: { endpoint: 'local' } }
  )
  await waitFor(() =>
    expect(port.postMessage).toHaveBeenCalledWith({ windowId: 1 })
  )
  vi.useFakeTimers()
  const receipt: PopupReceipt = {
    operationId: 'op1',
    taskId: 'task1',
    endpointId: 'local',
    endpointRevision: 0,
    windowId: 1,
    count: 2,
    expiresAt: Date.now() + 10000,
  }
  await act(async () => {
    messages[0]?.({
      kind: POPUP_RECEIPT_EVENT,
      receipt: { ...receipt, endpointId: 'other' },
    })
  })
  expect(refresh).not.toHaveBeenCalled()
  await act(async () => {
    messages[0]?.({ kind: POPUP_RECEIPT_EVENT, receipt })
  })
  expect(refresh).toHaveBeenCalledOnce()
  expect(result.current?.count).toBe(2)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000)
  })
  expect(result.current).toBeNull()
  rerender({ endpoint: 'other' })
  expect(result.current).toBeNull()
  unmount()
  expect(port.disconnect).toHaveBeenCalled()
})

it('does not let a delayed stored receipt replace a newer live receipt', async () => {
  let resolveStored!: (receipt: PopupReceipt) => void
  vi.mocked(send).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveStored = resolve
      }) as never
  )
  const messages: ((message: unknown) => void)[] = []
  Object.assign(browser, {
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
  })
  Object.assign(browser.runtime, {
    connect: vi.fn(() => ({
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: vi.fn((fn) => messages.push(fn)) },
      onDisconnect: { addListener: vi.fn() },
    })),
  })
  const refresh = vi.fn(async () => {})
  const { result } = renderHook(() => useAutoPopupReceipt('local', 0, refresh))
  await waitFor(() => expect(resolveStored).toBeDefined())
  const receipt: PopupReceipt = {
    operationId: 'new-op',
    taskId: 'new-task',
    endpointId: 'local',
    endpointRevision: 0,
    windowId: 1,
    count: 2,
    expiresAt: Date.now() + 10000,
  }
  await act(async () => {
    messages[0]?.({ kind: POPUP_RECEIPT_EVENT, receipt })
    resolveStored({
      ...receipt,
      operationId: 'old-op',
      taskId: 'old-task',
      count: 1,
      expiresAt: receipt.expiresAt - 1000,
    })
  })
  expect(result.current).toEqual(receipt)
  expect(refresh).toHaveBeenCalledOnce()
})
