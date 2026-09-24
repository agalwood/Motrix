import '@renderer/lib/i18n'
import { ByteUnitSync } from '@renderer/components/byte-unit-sync'
import { LanguageSync } from '@renderer/components/language-sync'
import { ReducedMotionSync } from '@renderer/components/reduced-motion-sync'
import { ThemeSync } from '@renderer/components/theme-sync'
import { toast } from '@renderer/components/ui/toast'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { useEngineRestartRequiredToast } from '@renderer/hooks/use-engine-restart-required-toast'
import { useLiquidGlass } from '@renderer/hooks/use-liquid-glass'
import { applyRendererLocale, i18n } from '@renderer/lib/i18n'
import {
  getReducedMotion,
  setAppReduceMotion,
} from '@renderer/lib/reduced-motion'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onSettingsRefresh } from './settings-refresh'
import { saveSettings, synchronizeSavedSettings } from './settings-save'

const mocks = vi.hoisted(() => ({ setTheme: vi.fn() }))
vi.mock('next-themes', () => ({
  useTheme: () => ({ setTheme: mocks.setTheme }),
}))
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    platform: 'web',
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getConnectionState: () => 'disconnected',
    onConnectionChange: vi.fn(() => () => {}),
  },
}))
vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: vi.fn(), close: vi.fn(), update: vi.fn() },
}))

let app = structuredClone(DEFAULT_APP_SETTINGS)
let failRead = false
let result = { saved: true, requiresRestart: false, applicationFailed: false }
function State() {
  const bytes = useByteFormat()
  const glass = useLiquidGlass()
  useEngineRestartRequiredToast()
  return (
    <output>
      {bytes.unitSystem}:{String(glass)}
    </output>
  )
}
function Root() {
  return (
    <>
      <LanguageSync />
      <ByteUnitSync />
      <ReducedMotionSync />
      <ThemeSync />
      <State />
    </>
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  app = {
    ...structuredClone(DEFAULT_APP_SETTINGS),
    language: 'en-US',
    byteUnitSystem: 'decimal',
    reduceMotion: false,
    liquidGlassEffect: false,
  }
  failRead = false
  result = { saved: true, requiresRestart: false, applicationFailed: false }
  setAppReduceMotion(false)
  await applyRendererLocale('en-US')
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }))
  )
  vi.mocked(transport.invoke).mockImplementation(async (channel, ...args) => {
    if (channel === Queries.GetSettings) {
      if (failRead) throw new Error('HTTP read failed')
      return { app: structuredClone(app) }
    }
    if (channel === Commands.UpdateSettings) {
      Object.assign(app, (args[0] as { app?: object }).app)
      return result
    }
    return { ok: true }
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setAppReduceMotion(false)
})

describe('HTTP settings save without an event socket', () => {
  it('hydrates the saved language on authenticated web mount', async () => {
    app.language = 'zh-CN'
    render(<LanguageSync />)
    await waitFor(() => expect(i18n.resolvedLanguage).toBe('zh-CN'))
  })

  it('applies language, units, motion, glass and theme through one shared readback', async () => {
    render(<Root />)
    await waitFor(() => expect(mocks.setTheme).toHaveBeenCalled())
    vi.mocked(transport.invoke).mockClear()
    await act(async () => {
      await saveSettings({
        app: {
          language: 'zh-CN',
          byteUnitSystem: 'binary',
          reduceMotion: true,
          liquidGlassEffect: true,
          theme: 'dark',
        },
      })
    })
    expect(i18n.resolvedLanguage).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(getReducedMotion()).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('binary:true')
    expect(mocks.setTheme).toHaveBeenLastCalledWith('dark')
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(([channel]) => channel === Queries.GetSettings)
    ).toHaveLength(1)
  })

  it('keeps a successful save successful when readback fails and retries only synchronization', async () => {
    render(<Root />)
    await waitFor(() => expect(mocks.setTheme).toHaveBeenCalled())
    failRead = true
    await act(async () => {
      expect(
        await saveSettings({ app: { byteUnitSystem: 'binary' } })
      ).toMatchObject({ saved: true })
    })
    expect(app.byteUnitSystem).toBe('binary')
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'settings-sync-failed', type: 'warning' })
    )
    const warning = vi
      .mocked(toast.add)
      .mock.calls.find(([options]) => options.id === 'settings-sync-failed')![0]
    failRead = false
    await act(async () => {
      warning.actionProps?.onClick?.({} as never)
    })
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('binary:false')
    )
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(([channel]) => channel === Commands.UpdateSettings)
    ).toHaveLength(1)
    expect(toast.close).toHaveBeenLastCalledWith('settings-sync-failed')
  })

  it('shows the restart requirement from the HTTP response without a pushed event', async () => {
    render(<Root />)
    result.requiresRestart = true
    await act(async () => {
      await saveSettings({ engine: { rpcPort: 9999 } })
    })
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'engine-restart-required', timeout: 0 })
    )
  })

  it('ignores a stale readback failure after a newer synchronization succeeds', async () => {
    let rejectRead!: (error: Error) => void
    const refresh = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectRead = reject
          })
      )
      .mockResolvedValue(undefined)
    const stop = onSettingsRefresh(refresh)
    try {
      const older = synchronizeSavedSettings()
      await synchronizeSavedSettings()
      rejectRead(new Error('stale read failed'))
      await older
      expect(toast.add).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it('reports a saved configuration that could not be applied', async () => {
    result.applicationFailed = true
    await saveSettings({ engine: { split: 8 } })
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Settings saved; some changes could not be applied',
        type: 'warning',
      })
    )
  })

  it('does not refresh or claim success when the write rejects', async () => {
    const refresh = vi.fn()
    const stop = onSettingsRefresh(refresh)
    vi.mocked(transport.invoke).mockRejectedValueOnce(new Error('write failed'))
    try {
      await expect(
        saveSettings({ app: { language: 'zh-CN' } })
      ).rejects.toThrow('write failed')
      expect(refresh).not.toHaveBeenCalled()
      expect(toast.add).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
})
