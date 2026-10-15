import '@renderer/lib/i18n'
import { Commands } from '@shared/protocol/commands'
import { act, renderHook } from '@testing-library/react'
import i18n from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginEnabled } from './use-plugin-enabled'

const { invoke, addToast, applyStatus } = vi.hoisted(() => ({
  invoke: vi.fn(),
  addToast: vi.fn(),
  applyStatus: vi.fn(),
}))
vi.mock('@renderer/lib/transport', () => ({ transport: { invoke } }))
vi.mock('@renderer/components/ui/toast', () => ({ toast: { add: addToast } }))
vi.mock('../store', () => ({
  usePluginsStore: (select: (state: unknown) => unknown) =>
    select({ applyStatus }),
}))

beforeEach(async () => {
  vi.clearAllMocks()
  invoke.mockResolvedValue({ ok: true })
  await i18n.changeLanguage('en-US')
})
afterEach(async () => {
  await i18n.changeLanguage('en-US')
})

describe('plugin enable runtime feedback', () => {
  it.each([
    ['ffmpegUnavailable', 'FFmpeg is unavailable.'],
    ['ffmpegIncompatible', 'The FFmpeg version does not meet'],
  ])(
    'localizes %s from Electron without changing enabled state',
    async (code, text) => {
      invoke.mockRejectedValueOnce(
        new Error(
          `Error invoking remote method 'command:enablePlugin': AppError: plugin.runtime.${code}`
        )
      )
      const { result } = renderHook(() => usePluginEnabled('community.test'))
      await act(() => result.current.toggleEnabled(true))
      expect(addToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          title: expect.stringContaining(text),
        })
      )
      expect(applyStatus).not.toHaveBeenCalled()
      expect(result.current.pending).toBe(false)
    }
  )

  it('uses the current host language for a server runtime failure', async () => {
    await i18n.changeLanguage('zh-CN')
    invoke.mockRejectedValueOnce(new Error('plugin.runtime.ffmpegUnavailable'))
    const { result } = renderHook(() => usePluginEnabled('community.test'))
    await act(() => result.current.toggleEnabled(true))
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: i18n.t('plugin.runtime.ffmpegUnavailable'),
      })
    )
    expect(applyStatus).not.toHaveBeenCalled()
  })

  it('serializes repeated clicks without overwriting authoritative status on completion', async () => {
    let resolve!: () => void
    invoke.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done
      })
    )
    const { result } = renderHook(() => usePluginEnabled('community.test'))
    act(() => {
      void result.current.toggleEnabled(true)
      void result.current.toggleEnabled(true)
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(Commands.EnablePlugin, 'community.test')
    expect(applyStatus).not.toHaveBeenCalled()
    expect(result.current.pending).toBe(true)
    await act(async () => {
      resolve()
    })
    expect(applyStatus).not.toHaveBeenCalled()
    expect(result.current.pending).toBe(false)
  })
})
