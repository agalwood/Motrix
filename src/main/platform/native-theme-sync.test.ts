import { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import type { AppSettings } from '@shared/types/settings'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { nativeThemeMock } = vi.hoisted(() => ({
  nativeThemeMock: {
    themeSource: 'system' as 'system' | 'light' | 'dark',
  },
}))

vi.mock('electron', () => ({
  nativeTheme: nativeThemeMock,
}))

import { setupNativeThemeSync } from './native-theme-sync'

function makeSettings(theme: 'system' | 'light' | 'dark'): AppSettings {
  return {
    app: { theme },
  } as unknown as AppSettings
}

function makeSettingsManager(theme: 'system' | 'light' | 'dark') {
  return {
    getApp: () => ({ theme }),
  } as unknown as Parameters<typeof setupNativeThemeSync>[1]
}

describe('setupNativeThemeSync', () => {
  beforeEach(() => {
    nativeThemeMock.themeSource = 'system'
  })

  it('applies the persisted theme to nativeTheme on setup', () => {
    const bus = new EventBus()
    setupNativeThemeSync(bus, makeSettingsManager('dark'))
    expect(nativeThemeMock.themeSource).toBe('dark')
  })

  it('updates nativeTheme.themeSource when SettingsChanged carries a new theme', () => {
    const bus = new EventBus()
    setupNativeThemeSync(bus, makeSettingsManager('system'))
    expect(nativeThemeMock.themeSource).toBe('system')

    bus.emit(Events.SettingsChanged, {
      old: makeSettings('system'),
      updated: makeSettings('dark'),
    })
    expect(nativeThemeMock.themeSource).toBe('dark')

    bus.emit(Events.SettingsChanged, {
      old: makeSettings('dark'),
      updated: makeSettings('light'),
    })
    expect(nativeThemeMock.themeSource).toBe('light')
  })

  it('ignores SettingsChanged when theme is unchanged', () => {
    const bus = new EventBus()
    setupNativeThemeSync(bus, makeSettingsManager('dark'))
    nativeThemeMock.themeSource = 'system' // simulate external override

    bus.emit(Events.SettingsChanged, {
      old: makeSettings('dark'),
      updated: makeSettings('dark'),
    })
    expect(nativeThemeMock.themeSource).toBe('system')
  })

  it('destroy() unsubscribes from the EventBus', () => {
    const bus = new EventBus()
    const handle = setupNativeThemeSync(bus, makeSettingsManager('system'))
    handle.destroy()

    bus.emit(Events.SettingsChanged, {
      old: makeSettings('system'),
      updated: makeSettings('dark'),
    })
    expect(nativeThemeMock.themeSource).toBe('system')
  })
})
