import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { useEffect } from 'react'

interface Options {
  width: number
  minHeight: number
  maxHeight: number
  /** Chrome height (non-content) to add on top of measured content. */
  chromeHeight?: number
  /** CSS selector for the element whose scrollHeight represents content. */
  contentSelector?: string
  enabled?: boolean
}

/**
 * Adaptively resizes the host Electron window to fit the form's natural
 * content height, clamped to `[minHeight, maxHeight]`. Above `maxHeight`,
 * content scrolls internally. The measured element must sit inside that
 * scroll viewport so its `scrollHeight` can shrink with the natural content
 * instead of being floored by the viewport's current height.
 *
 * Measures the element matching `contentSelector` (default
 * `[data-adaptive-content]`) via `scrollHeight`. Adds `chromeHeight` to
 * account for the window chrome bar above the form.
 *
 * Batches via `requestAnimationFrame` and skips sub-2px deltas to avoid
 * feedback loops from `setSize` -> CSS reflow -> ResizeObserver fire.
 */
export function useAdaptiveWindowHeight({
  width,
  minHeight,
  maxHeight,
  chromeHeight = 40,
  contentSelector = '[data-adaptive-content]',
  enabled = true,
}: Options) {
  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined') return

    let raf = 0
    let last = 0
    let contentEl: HTMLElement | null = null
    let ro: ResizeObserver | null = null

    const measure = () => {
      const el =
        contentEl ??
        (document.querySelector(contentSelector) as HTMLElement | null)
      if (!el) return
      if (el !== contentEl) {
        contentEl = el
        ro?.observe(el)
      }
      const contentH = el.scrollHeight
      const desired = chromeHeight + contentH
      const clamped = Math.min(
        maxHeight,
        Math.max(minHeight, Math.ceil(desired))
      )
      if (Math.abs(clamped - last) < 2) return
      last = clamped
      void transport.invoke(Commands.ResizeWindow, {
        width,
        height: clamped,
      })
    }

    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }

    ro = new ResizeObserver(schedule)
    ro.observe(document.body)

    // Mutations (Collapsible open/close, tab switch, torrent load) can change
    // layout without firing ResizeObserver on body; cover them explicitly.
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'aria-expanded', 'hidden'],
    })

    // Initial measurement after first paint.
    schedule()

    return () => {
      ro?.disconnect()
      mo.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [width, minHeight, maxHeight, chromeHeight, contentSelector, enabled])
}
