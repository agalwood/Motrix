export const TRACKER_SCHEME_WHITELIST = [
  'http',
  'https',
  'udp',
  'ws',
  'wss',
] as const

type TrackerScheme = (typeof TRACKER_SCHEME_WHITELIST)[number]

const SCHEME_RE = /^([a-z]+):/i

export interface ParseResult {
  valid: string[]
  dropped: number
}

export function parseTrackerInput(text: string): ParseResult {
  const seen = new Set<string>()
  const valid: string[] = []
  let dropped = 0

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = trimmed.match(SCHEME_RE)
    const scheme = match?.[1]?.toLowerCase()
    if (
      !scheme ||
      !TRACKER_SCHEME_WHITELIST.includes(scheme as TrackerScheme)
    ) {
      dropped++
      continue
    }
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    valid.push(trimmed)
  }
  return { valid, dropped }
}
