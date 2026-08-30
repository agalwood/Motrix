import type { Browser } from '@shared/protocol/bridge'

/**
 * The one human-facing name per `Browser` family. Every surface that shows a
 * caller's browser (pairing toast, browser-extensions table, trusted
 * extensions table) reads this map, so adding a family to the `Browser`
 * union fails `tsc` here instead of silently falling through an inline
 * ternary somewhere. Brand names, not translations — they stay identical in
 * every locale.
 */
const BROWSER_DISPLAY_NAMES: Record<Browser, string> = {
  chromium: 'Chrome / Edge',
  firefox: 'Firefox',
}

export function browserDisplayName(browser: Browser): string {
  return BROWSER_DISPLAY_NAMES[browser]
}
