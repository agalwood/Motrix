import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import type { AppSettings } from '@shared/types/settings'
import { useTheme } from 'next-themes'
import { useEffect } from 'react'

// Bridges the persisted `app.theme` setting (source of truth in main) into
// next-themes on mount. next-themes then handles class-on-<html>, system
// detection, and cross-component reactivity. Subsequent edits go through
// AppearanceDialog, which calls setTheme directly after persisting.
export function ThemeSync() {
  const { setTheme } = useTheme()

  useEffect(() => {
    let cancelled = false
    transport
      .invoke(Queries.GetSettings)
      .then((data) => {
        if (cancelled) return
        const all = data as AppSettings | undefined
        const theme = all?.app?.theme
        if (theme) setTheme(theme)
      })
      .catch(() => {
        /* keep next-themes default (system) */
      })
    return () => {
      cancelled = true
    }
  }, [setTheme])

  return null
}
