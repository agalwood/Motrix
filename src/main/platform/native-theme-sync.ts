import type { EventBus } from '@core/events/event-bus'
import type { SettingsManager } from '@core/settings/settings-manager'
import { Events } from '@shared/protocol/events'
import type { AppSettings, MotrixAppSettings } from '@shared/types/settings'
import { nativeTheme } from 'electron'

export interface NativeThemeSyncHandle {
  destroy(): void
}

// Bridges the persisted `app.theme` setting to Electron's `nativeTheme`.
// This is what makes the user's choice flow into:
//   - macOS vibrancy material + traffic-light/titlebar tint
//   - Windows custom-title-bar colors through `prefers-color-scheme`
//   - the OS-reported `prefers-color-scheme` (and thus the renderer's
//     own dark-class application via next-themes when in `system` mode)
//   - the Linux tray icon picker (reads `nativeTheme.shouldUseDarkColors`)
//
// Server runtime has no native chrome and cannot import `electron`, so this
// module is Electron-only. The renderer's <html>.dark toggle (next-themes +
// ThemeSync) stays runtime-agnostic and works in both Electron and browser.
export function setupNativeThemeSync(
  eventBus: EventBus,
  settingsManager: SettingsManager,
  onResolvedThemeChanged?: (shouldUseDarkColors: boolean) => void
): NativeThemeSyncHandle {
  let lastShouldUseDarkColors: boolean | undefined

  function notifyResolvedThemeChanged() {
    const shouldUseDarkColors = nativeTheme.shouldUseDarkColors
    if (shouldUseDarkColors === lastShouldUseDarkColors) return
    lastShouldUseDarkColors = shouldUseDarkColors
    onResolvedThemeChanged?.(shouldUseDarkColors)
  }

  function onNativeThemeUpdated() {
    notifyResolvedThemeChanged()
  }

  nativeTheme.on('updated', onNativeThemeUpdated)
  apply(settingsManager.getApp().theme)
  notifyResolvedThemeChanged()

  function onSettingsChanged(payload: unknown) {
    const { old, updated } = payload as {
      old: AppSettings
      updated: AppSettings
    }
    if (old.app.theme !== updated.app.theme) {
      apply(updated.app.theme)
      notifyResolvedThemeChanged()
    }
  }

  eventBus.on(Events.SettingsChanged, onSettingsChanged)

  return {
    destroy() {
      eventBus.off(Events.SettingsChanged, onSettingsChanged)
      nativeTheme.off('updated', onNativeThemeUpdated)
    },
  }
}

function apply(theme: MotrixAppSettings['theme']) {
  nativeTheme.themeSource = theme
}
