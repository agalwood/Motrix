/**
 * Coarse relative-time formatter (seconds/minutes/hours/days) — good enough
 * for a task row or a notification-center row. Shared by `TasksTile`
 * (dashboard "Failed"/"Recent" rows) and `NotificationsPage`, which
 * previously carried near-identical copies of this function. An invalid or
 * non-positive timestamp renders as an em dash instead of a nonsensical
 * "in -12345 years"-style string.
 */
export function formatRelativeTime(
  timestamp: number | null,
  now: number,
  locale: string
): string {
  if (timestamp === null || !Number.isFinite(timestamp) || timestamp <= 0) {
    return '—'
  }

  const deltaMs = timestamp - now
  const absoluteMs = Math.abs(deltaMs)
  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: 'auto',
    style: 'short',
  })

  if (absoluteMs < 60_000) return formatter.format(0, 'second')
  if (absoluteMs < 3_600_000) {
    return formatter.format(Math.round(deltaMs / 60_000), 'minute')
  }
  if (absoluteMs < 86_400_000) {
    return formatter.format(Math.round(deltaMs / 3_600_000), 'hour')
  }
  return formatter.format(Math.round(deltaMs / 86_400_000), 'day')
}
