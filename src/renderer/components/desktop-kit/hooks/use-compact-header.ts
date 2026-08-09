import { SidebarContext } from '@renderer/components/ui/sidebar'
import { useContext } from 'react'

/**
 * True when the app header is in its compact (short) state: viewport below
 * the md breakpoint or sidebar collapsed. Mirrors the CSS `compact-header:`
 * variant in globals.css — keep both in sync.
 *
 * Reads SidebarContext optionally and degrades to `false` (full) outside a
 * SidebarProvider so consumers stay renderable standalone (tests, stories).
 */
export function useCompactHeader(): boolean {
  const ctx = useContext(SidebarContext)
  if (!ctx) return false
  return ctx.isMobile || ctx.state === 'collapsed'
}
