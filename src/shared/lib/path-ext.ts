export function extractExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (dot <= slash + 1) return ''
  return filePath.slice(dot).toLowerCase()
}

/**
 * Compute a torrent-internal (or save-dir-relative) display path from
 * aria2's absolute file path. Tries each anchor in order; if one is a
 * prefix of `absolutePath`, returns the suffix after it. Falls back to
 * the basename so HTTP/single-file paths stay sane even when no anchor
 * matches (e.g. when `diskPath` is empty for legacy tasks).
 */
export function relativizeTorrentPath(
  absolutePath: string,
  ...anchors: Array<string | null | undefined>
): string {
  for (const anchor of anchors) {
    if (!anchor) continue
    const sep = anchor.includes('\\') ? '\\' : '/'
    const prefix = anchor.endsWith(sep) ? anchor : anchor + sep
    if (absolutePath.startsWith(prefix)) {
      return absolutePath.slice(prefix.length)
    }
  }
  const lastSep = Math.max(
    absolutePath.lastIndexOf('/'),
    absolutePath.lastIndexOf('\\')
  )
  return lastSep >= 0 ? absolutePath.slice(lastSep + 1) : absolutePath
}
