/**
 * Resolves a translation key that may be UNVERIFIED — core's occurrence
 * consumer stores the first `reasonCandidates` entry for a task-error
 * `bodyKey` without checking the renderer's catalog (it cannot reach i18n
 * from `src/core/`), so the key that lands here can be missing. Mirrors the
 * verify-or-fallback idiom in `resolveFailureReason`
 * (`src/renderer/lib/failure-reason.ts`): a present key renders translated,
 * a missing key renders as-is and logs once so the gap is visible without
 * crashing the caller. Shared by `NotificationsPage` (the durable list) and
 * `useNotificationToasts` (the focused-error toast), which previously
 * carried a diverging pair of copies — one warned on a miss, the other
 * stayed silent.
 */
export function resolveNotificationText(
  key: string,
  params: Record<string, string> | null,
  t: (key: string, params?: Record<string, string>) => string,
  exists: (key: string) => boolean
): string {
  if (exists(key)) return t(key, params ?? undefined)
  console.warn(`notification-center: missing i18n key "${key}"`)
  return key
}
