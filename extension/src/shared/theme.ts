import { extensionBrowser as browser } from '@/shared/browser'
import {
  getThemeOverride,
  THEME_KEY,
  type ThemeOverride,
} from '@/shared/themeStore'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function applyDark(isDark: boolean): void {
  document.documentElement.classList.toggle('dark', isDark)
}

function resolveDark(
  override: ThemeOverride | null,
  systemDark: boolean
): boolean {
  if (override === 'dark') return true
  if (override === 'light') return false
  return systemDark
}

/**
 * Apply the effective theme to <html> and keep it in sync. Effective theme =
 * stored override ('light'|'dark') if present, otherwise the OS preference.
 * Reacts to both OS changes and storage changes (so options/popup stay in
 * sync). Synchronous first paint follows the OS to minimise flash; the stored
 * override is applied as soon as it loads. No-ops without matchMedia.
 */
export function initTheme(): () => void {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return () => {}
  }
  const mql = window.matchMedia(DARK_QUERY)
  let override: ThemeOverride | null = null

  const recompute = (): void => applyDark(resolveDark(override, mql.matches))

  recompute()
  void getThemeOverride()
    .then((o) => {
      override = o
      recompute()
    })
    .catch(() => {
      // storage unavailable — stay on OS theme
    })

  const onMedia = (): void => recompute()
  mql.addEventListener('change', onMedia)

  const onStorage = (
    changes: Record<string, { newValue?: unknown }>,
    area: string
  ): void => {
    if (area !== 'local' || !(THEME_KEY in changes)) return
    const nv = changes[THEME_KEY]?.newValue
    override = nv === 'light' || nv === 'dark' ? nv : null
    recompute()
  }
  browser.storage.onChanged.addListener(onStorage)

  return () => {
    mql.removeEventListener('change', onMedia)
    browser.storage.onChanged.removeListener(onStorage)
  }
}
