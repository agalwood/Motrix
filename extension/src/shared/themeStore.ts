import { extensionBrowser as browser } from '@/shared/browser'

const THEME_KEY = 'motrix.theme'

export type ThemeOverride = 'light' | 'dark'

export async function getThemeOverride(): Promise<ThemeOverride | null> {
  const got = await browser.storage.local.get(THEME_KEY)
  const v = got[THEME_KEY]
  return v === 'light' || v === 'dark' ? v : null
}

export async function setThemeOverride(v: ThemeOverride | null): Promise<void> {
  if (v === null) {
    await browser.storage.local.remove(THEME_KEY)
  } else {
    await browser.storage.local.set({ [THEME_KEY]: v })
  }
}

export { THEME_KEY }
