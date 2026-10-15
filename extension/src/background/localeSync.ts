import { initI18n } from '@/shared/i18n'
import { LOCALE_KEY } from '@/shared/localeStore'

type StorageChange = { newValue?: unknown; oldValue?: unknown }
type StorageChanges = Record<string, StorageChange>

/**
 * Returns a storage.onChanged listener that re-applies the i18n locale
 * whenever `motrix.locale` changes in local storage, then calls `onApplied`.
 *
 * Extract this logic so it can be unit-tested in isolation without importing
 * the service-worker bootstrap (background/service-worker.ts has side effects).
 */
export function makeLocaleChangeHandler(
  onApplied: () => void
): (changes: StorageChanges, area: string) => void {
  return (changes, area) => {
    if (area !== 'local' || !changes[LOCALE_KEY]) return
    void initI18n().then(() => onApplied())
  }
}
