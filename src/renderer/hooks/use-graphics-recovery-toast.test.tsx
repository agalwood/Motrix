import '@renderer/lib/i18n'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { add, close, invoke, transportMock } = vi.hoisted(() => {
  const invoke = vi.fn()
  return {
    add: vi.fn(),
    close: vi.fn(),
    invoke,
    transportMock: { platform: 'darwin', invoke },
  }
})
vi.mock('@renderer/components/ui/toast', () => ({ toast: { add, close } }))
vi.mock('@renderer/lib/transport', () => ({ transport: transportMock }))

import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { useGraphicsRecoveryToast } from './use-graphics-recovery-toast'

const notice = { id: '6acb7e2d-1982-4a14-aea1-773001123456' }

describe('graphics recovery toast', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transportMock.platform = 'darwin'
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    invoke.mockResolvedValue(notice)
  })
  afterEach(() => vi.restoreAllMocks())

  it('shows a durable explanation and acknowledges only when dismissed', async () => {
    renderHook(() => useGraphicsRecoveryToast())
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1))
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Hardware acceleration was turned off',
        description: expect.stringContaining('Settings → Appearance'),
        timeout: 0,
      })
    )
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      Queries.GetGraphicsRecoveryNotice
    )
    act(() => add.mock.calls[0]![0].onClose())
    expect(invoke).toHaveBeenLastCalledWith(
      Commands.AcknowledgeGraphicsRecoveryNotice,
      notice
    )
  })

  it('waits for a hidden window to become visible and does not duplicate the notice', async () => {
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden')
    renderHook(() => useGraphicsRecoveryToast())
    expect(invoke).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1))
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    expect(add).toHaveBeenCalledTimes(1)
  })

  it('leaves an unseen notice pending when a renderer closes during the query', async () => {
    let resolve!: (value: unknown) => void
    invoke.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const hook = renderHook(() => useGraphicsRecoveryToast())
    hook.unmount()
    await act(async () => resolve(notice))
    expect(add).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('does not acknowledge an existing notice when the renderer unmounts', async () => {
    const hook = renderHook(() => useGraphicsRecoveryToast())
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1))
    close.mockImplementation(() => add.mock.calls[0]![0].onClose())
    hook.unmount()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('retries a query that races IPC startup', async () => {
    invoke
      .mockRejectedValueOnce(new Error('not ready'))
      .mockResolvedValue(notice)
    renderHook(() => useGraphicsRecoveryToast())
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1), {
      timeout: 2_000,
    })
  })

  it('does not request desktop recovery in a web browser', () => {
    transportMock.platform = 'web'
    renderHook(() => useGraphicsRecoveryToast())
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not show a toast for a normal startup', async () => {
    invoke.mockResolvedValue(null)
    renderHook(() => useGraphicsRecoveryToast())
    await act(async () => {})
    expect(add).not.toHaveBeenCalled()
  })
})
