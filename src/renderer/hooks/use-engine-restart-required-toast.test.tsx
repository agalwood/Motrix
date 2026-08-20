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
  },
}))

describe('useEngineRestartRequiredToast', () => {
  beforeEach(() => {
    listeners.clear()
    vi.mocked(transport.invoke).mockClear()
    vi.mocked(toast.add).mockClear()
    vi.mocked(toast.close).mockClear()
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
