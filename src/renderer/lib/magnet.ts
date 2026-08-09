export interface MagnetUriOptions {
  /** Display name (`dn=`). Encoded as a URI component. */
  name?: string
  /** Tracker URLs (`tr=`). Blanks dropped, duplicates collapsed. */
  trackers?: readonly string[]
}

export function infoHashToMagnetUri(
  infoHash: string,
  options: MagnetUriOptions = {}
): string {
  const parts = [`xt=urn:btih:${infoHash.trim()}`]
  if (options.name) {
    parts.push(`dn=${encodeURIComponent(options.name)}`)
  }
  const seen = new Set<string>()
  for (const tracker of options.trackers ?? []) {
    const trimmed = tracker.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    parts.push(`tr=${encodeURIComponent(trimmed)}`)
  }
  return `magnet:?${parts.join('&')}`
}
