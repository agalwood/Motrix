import '@renderer/lib/i18n'
import { toast } from '@renderer/components/ui/toast'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { EngineState } from '@shared/types/engine'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ENGINE_RESTART_REQUIRED_TOAST_ID,
  useEngineRestartRequiredToast,
} from './use-engine-restart-required-toast'

const listeners = new Map<string, (...args: unknown[]) => void>()

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    platform: 'darwin',
    invoke: vi.fn().mockResolvedValue({ ok: true }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener)
    }),
    off: vi.fn((event: string) => {
      listeners.delete(event)
    }),
  },
}))

vi.mock('@renderer/components/ui/toast', () => ({
  toast: {
    add: vi.fn(() => 'engine-restart-required'),
    close: vi.fn(),
    update: vi.fn(),
  },
}))

describe('useEngineRestartRequiredToast', () => {
  beforeEach(() => {
    listeners.clear()
    vi.mocked(transport.invoke).mockClear()
    vi.mocked(toast.add).mockClear()
    vi.mocked(toast.close).mockClear()
    vi.mocked(toast.update).mockClear()
    vi.mocked(transport.invoke).mockResolvedValue({ ok: true })
  })

  it('shows one sticky warning whose action restarts the engine', () => {
    renderHook(() => useEngineRestartRequiredToast())

    act(() => {
      listeners.get(Events.EngineRestartRequired)?.({
        changedKeys: ['rpcPort'],
      })
    })

    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ENGINE_RESTART_REQUIRED_TOAST_ID,
        title: 'Restart the download engine to apply settings',
        description:
          'Your settings are saved. Restart the download engine when convenient.',
        type: 'warning',
        timeout: 0,
      })
    )
    const options = vi.mocked(toast.add).mock.calls[0]?.[0]
    act(() => {
      options?.actionProps?.onClick?.({} as never)
    })
    expect(transport.invoke).toHaveBeenCalledWith(Commands.RestartEngine)
  })

  it('disables immediately and ignores repeated clicks while restart is pending', async () => {
    let resolveRestart!: (value: unknown) => void
    vi.mocked(transport.invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRestart = resolve
        })
    )
    renderHook(() => useEngineRestartRequiredToast())
    act(() => {
      listeners.get(Events.EngineRestartRequired)?.({
        changedKeys: ['rpcPort'],
      })
    })
    const action = vi.mocked(toast.add).mock.calls[0]?.[0].actionProps?.onClick

    act(() => {
      action?.({} as never)
      action?.({} as never)
    })

    expect(transport.invoke).toHaveBeenCalledOnce()
    expect(toast.update).toHaveBeenCalledWith(
      ENGINE_RESTART_REQUIRED_TOAST_ID,
      expect.objectContaining({
        actionProps: expect.objectContaining({
          disabled: true,
          'aria-busy': true,
        }),
      })
    )

    await act(async () => {
      resolveRestart({ ok: true })
      await Promise.resolve()
    })
  })

  it('re-enables restart after a failed invocation', async () => {
    vi.mocked(transport.invoke)
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValueOnce({ ok: true })
    renderHook(() => useEngineRestartRequiredToast())
    act(() => {
      listeners.get(Events.EngineRestartRequired)?.({
        changedKeys: ['rpcPort'],
      })
    })
    const action = vi.mocked(toast.add).mock.calls[0]?.[0].actionProps?.onClick

    await act(async () => {
      action?.({} as never)
      await Promise.resolve()
    })

    expect(toast.update).toHaveBeenLastCalledWith(
      ENGINE_RESTART_REQUIRED_TOAST_ID,
      expect.objectContaining({
        actionProps: expect.objectContaining({ disabled: false }),
      })
    )
    act(() => {
      action?.({} as never)
    })
    expect(transport.invoke).toHaveBeenCalledTimes(2)
  })

  it('closes the reminder when the engine becomes Ready and unsubscribes', () => {
    const { unmount } = renderHook(() => useEngineRestartRequiredToast())

    act(() => {
      listeners.get(Events.EngineStateChanged)?.(EngineState.Ready)
    })
    expect(toast.close).toHaveBeenCalledWith(ENGINE_RESTART_REQUIRED_TOAST_ID)

    unmount()
    expect(transport.off).toHaveBeenCalledWith(
      Events.EngineRestartRequired,
      expect.any(Function)
    )
    expect(transport.off).toHaveBeenCalledWith(
      Events.EngineStateChanged,
      expect.any(Function)
    )
  })
})
