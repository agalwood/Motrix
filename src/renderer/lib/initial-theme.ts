export type ResolvedRendererTheme = 'light' | 'dark'

interface ResolveInitialRendererThemeInput {
  target: 'electron' | 'web'
  storedTheme?: string | null
  prefersDark: boolean
}

/**
 * Resolve the class used before React mounts. Electron's main process applies
 * the persisted preference to nativeTheme before opening a window, so its
 * prefers-color-scheme value is authoritative. The web renderer has no native
 * theme bridge and therefore consults next-themes' localStorage value first.
 */
export function resolveInitialRendererTheme({
  target,
  storedTheme,
  prefersDark,
}: ResolveInitialRendererThemeInput): ResolvedRendererTheme {
  if (target === 'web' && (storedTheme === 'light' || storedTheme === 'dark')) {
    return storedTheme
  }
  return prefersDark ? 'dark' : 'light'
}

export function applyInitialRendererTheme(
  target: 'electron' | 'web' = __MOTRIX_TARGET__
): ResolvedRendererTheme {
  let storedTheme: string | null = null
  if (target === 'web') {
    try {
      storedTheme = window.localStorage.getItem('theme')
    } catch {
      // Storage may be disabled; the system preference remains a safe default.
    }
  }

  const theme = resolveInitialRendererTheme({
    target,
    storedTheme,
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  })
  const root = document.documentElement
  root.classList.remove(theme === 'dark' ? 'light' : 'dark')
  root.classList.add(theme)
  root.style.colorScheme = theme
  // The inline head style protects the blank document before the renderer
  // bundle loads. Once the semantic stylesheet and theme class are ready it
  // must be removed so platform rules such as macOS transparency can win.
  document.getElementById('motrix-theme-bootstrap')?.remove()
  return theme
}
