import { extensionBrowser } from '@/shared/browser'
import {
  isSupportedLocale,
  type SupportedLocale,
} from '@/shared/supportedLocales'

export type { SupportedLocale } from '@/shared/supportedLocales'

const LOCALE_KEY = 'motrix.locale'

export async function getLocaleOverride(): Promise<SupportedLocale | null> {
  const got = await extensionBrowser.storage.local.get(LOCALE_KEY)
  const v = got[LOCALE_KEY]
  return isSupportedLocale(v) ? v : null
}

export async function setLocaleOverride(
  v: SupportedLocale | null
): Promise<void> {
  if (v === null) {
    await extensionBrowser.storage.local.remove(LOCALE_KEY)
  } else {
    await extensionBrowser.storage.local.set({ [LOCALE_KEY]: v })
  }
}

export { LOCALE_KEY }
