import {
  type ByteRange,
  type InitSegment,
  type KeyRef,
  MediaParseError,
  type MediaPart,
  resolveUri,
  type SegmentPlan,
  seqNumberIv,
} from './segment-plan'

// ---------------------------------------------------------------------------
// Attribute parsing helpers
// ---------------------------------------------------------------------------

/** Extract a quoted or unquoted attribute value by name from an HLS attribute list. */
function attr(attrs: string, name: string): string | undefined {
  // Quoted: NAME="..."
  const quoted = new RegExp(`${name}="([^"]*)"`, 'i').exec(attrs)
  if (quoted) return quoted[1]
  // Unquoted: NAME=value (value ends at comma or end of string)
  const unquoted = new RegExp(`${name}=([^,]*)`, 'i').exec(attrs)
  return unquoted?.[1]?.trim()
}

/** Parse BYTERANGE="length[@offset]" or "length@offset" → { length, offset? } */
function parseByteRangeAttr(val: string): { length: number; offset?: number } {
  const [lenStr, offStr] = val.split('@')
  return {
    length: Number(lenStr),
    offset: offStr !== undefined ? Number(offStr) : undefined,
  }
}

/** Parse hex string (with optional 0x prefix) into a 16-byte Uint8Array. */
function parseIvHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '').padStart(32, '0')
  const buf = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    buf[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return buf
}

// ---------------------------------------------------------------------------
// parseHlsMaster
// ---------------------------------------------------------------------------

interface Variant {
  url: string
  bandwidth: number
  audioGroup?: string
}

/**
 * Parse a master HLS playlist → pick the highest-BANDWIDTH variant URL and
 * (if it references an AUDIO group) the matching EXT-X-MEDIA rendition URI.
 */
export function parseHlsMaster(
  text: string,
  url: string
): { variantUrl: string; audioUrl?: string } {
  const lines = text.split(/\r?\n/)

  // Collect audio renditions by GROUP-ID
  const audioRenditions = new Map<string, string>() // groupId → resolved URI
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue
    const attrs = line.slice('#EXT-X-MEDIA:'.length)
    const type = attr(attrs, 'TYPE')
    if (type !== 'AUDIO') continue
    const groupId = attr(attrs, 'GROUP-ID')
    const uri = attr(attrs, 'URI')
    if (groupId && uri) {
      audioRenditions.set(groupId, resolveUri(url, uri))
    }
  }

  // Collect stream variants
  const variants: Variant[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line?.startsWith('#EXT-X-STREAM-INF:')) continue
    const attrs = line.slice('#EXT-X-STREAM-INF:'.length)
    const bandwidth = Number(attr(attrs, 'BANDWIDTH') ?? '0')
    const audioGroup = attr(attrs, 'AUDIO')
    const uriLine = lines[i + 1]?.trim()
    if (uriLine && !uriLine.startsWith('#')) {
      variants.push({
        url: resolveUri(url, uriLine),
        bandwidth,
        audioGroup,
      })
    }
  }

  if (variants.length === 0) {
    throw new MediaParseError(
      'unsupported-master',
      'master playlist has no variants'
    )
  }

  const best = variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a))
  const audioUrl =
    best.audioGroup != null ? audioRenditions.get(best.audioGroup) : undefined

  return { variantUrl: best.url, ...(audioUrl ? { audioUrl } : {}) }
}

// ---------------------------------------------------------------------------
// parseHlsMedia
// ---------------------------------------------------------------------------

/**
 * Parse a media (non-master) HLS playlist into a SegmentPlan.
 *
 * Handles:
 *  - EXT-X-MAP → init segment + fmp4 container
 *  - EXT-X-KEY AES-128 → per-segment KeyRef; explicit IV or seqNumberIv(seq)
 *  - METHOD=NONE → clears active key
 *  - METHOD=SAMPLE-AES/other → MediaParseError('unsupported-encryption')
 *  - EXT-X-BYTERANGE with running per-resource offset
 *  - Live guard: no ENDLIST and not PLAYLIST-TYPE:VOD → MediaParseError('unsupported-live')
 */
export function parseHlsMedia(text: string, url: string): SegmentPlan {
  const lines = text.split(/\r?\n/)

  const hasEndlist = lines.some((l) => l.startsWith('#EXT-X-ENDLIST'))
  const playlistType = lines
    .find((l) => l.startsWith('#EXT-X-PLAYLIST-TYPE:'))
    ?.slice('#EXT-X-PLAYLIST-TYPE:'.length)
    ?.trim()
    ?.toUpperCase()

  const isVod = playlistType === 'VOD'

  if (!hasEndlist && !isVod) {
    throw new MediaParseError('unsupported-live', 'live HLS is not supported')
  }

  // Parse MEDIA-SEQUENCE
  let seq = 0
  const seqLine = lines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'))
  if (seqLine) {
    seq = Number(seqLine.slice('#EXT-X-MEDIA-SEQUENCE:'.length).trim())
  }

  // Running state
  let activeKey: KeyRef | null = null
  let activeInit: InitSegment | undefined
  // Per-resource running byte offset (keyed by resolved URL)
  const runningOffset = new Map<string, number>()
  // Pending BYTERANGE for the next segment
  let pendingByteRange: { length: number; offset?: number } | undefined

  const segments: MediaPart[] = []
  let index = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    // EXT-X-KEY
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = line.slice('#EXT-X-KEY:'.length)
      const method = attr(attrs, 'METHOD')

      if (method === 'NONE') {
        activeKey = null
      } else if (method === 'AES-128') {
        const keyUri = attr(attrs, 'URI')
        if (!keyUri)
          throw new MediaParseError(
            'unsupported-encryption',
            'AES-128 key missing URI'
          )
        const ivAttr = attr(attrs, 'IV')
        // IV resolution happens per-segment (for seq-based IV)
        // Store a sentinel: if ivAttr is present, store the parsed bytes; else null
        const ivBytes: Uint8Array | null = ivAttr ? parseIvHex(ivAttr) : null
        // We store the IV on activeKey as a placeholder; per-segment we may override below
        // Use a special marker: store ivBytes or the placeholder for seq-based
        activeKey = {
          method: 'AES-128',
          uri: resolveUri(url, keyUri),
          // Temporary: will be resolved per-segment; use seqNumberIv(seq) as default
          iv: ivBytes ?? seqNumberIv(seq),
          _explicit: ivAttr !== undefined,
          _ivBytes: ivBytes,
        } as KeyRef & { _explicit: boolean; _ivBytes: Uint8Array | null }
      } else {
        // SAMPLE-AES or any unknown method
        throw new MediaParseError(
          'unsupported-encryption',
          `unsupported HLS encryption method: ${method}`
        )
      }
      continue
    }

    // EXT-X-MAP
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = line.slice('#EXT-X-MAP:'.length)
      const mapUri = attr(attrs, 'URI')
      if (!mapUri) continue
      const resolvedMapUrl = resolveUri(url, mapUri)
      const byteRangeAttr = attr(attrs, 'BYTERANGE')
      let mapByteRange: ByteRange | undefined
      if (byteRangeAttr) {
        const parsed = parseByteRangeAttr(byteRangeAttr)
        const offset =
          parsed.offset !== undefined
            ? parsed.offset
            : (runningOffset.get(resolvedMapUrl) ?? 0)
        mapByteRange = { offset, length: parsed.length }
        runningOffset.set(resolvedMapUrl, offset + parsed.length)
      }
      activeInit = {
        url: resolvedMapUrl,
        ...(mapByteRange ? { byteRange: mapByteRange } : {}),
        ...(activeKey ? { key: resolveKeyForSeq(activeKey, seq) } : {}),
      }
      continue
    }

    // EXT-X-BYTERANGE (before EXTINF, applies to next segment)
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const val = line.slice('#EXT-X-BYTERANGE:'.length).trim()
      pendingByteRange = parseByteRangeAttr(val)
      continue
    }

    // EXTINF → next non-comment line is segment URI
    if (line.startsWith('#EXTINF:')) {
      // Find the URI line (skip blank lines and tags)
      let uriLine = ''
      let byteRangeInline: { length: number; offset?: number } | undefined

      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? ''
        if (next.trim() === '') continue
        if (next.startsWith('#EXT-X-BYTERANGE:')) {
          // Inline EXT-X-BYTERANGE between EXTINF and URI
          byteRangeInline = parseByteRangeAttr(
            next.slice('#EXT-X-BYTERANGE:'.length).trim()
          )
          continue
        }
        if (!next.startsWith('#')) {
          uriLine = next.trim()
          i = j // advance outer loop
          break
        }
        break
      }

      if (!uriLine) continue

      const resolvedUrl = resolveUri(url, uriLine)

      // Resolve byteRange: inline > pending > none
      const rawByteRange = byteRangeInline ?? pendingByteRange
      pendingByteRange = undefined

      let byteRange: ByteRange | undefined
      if (rawByteRange) {
        const offset =
          rawByteRange.offset !== undefined
            ? rawByteRange.offset
            : (runningOffset.get(resolvedUrl) ?? 0)
        byteRange = { offset, length: rawByteRange.length }
        runningOffset.set(resolvedUrl, offset + rawByteRange.length)
      }

      // Resolve key with seq-based IV if needed
      const segKey = activeKey ? resolveKeyForSeq(activeKey, seq) : undefined

      segments.push({
        url: resolvedUrl,
        index,
        ...(byteRange ? { byteRange } : {}),
        ...(segKey ? { key: segKey } : {}),
      })

      index++
      seq++
    }
  }

  const container = activeInit ? 'fmp4' : 'mpegts'

  return {
    container,
    ...(activeInit ? { init: activeInit } : {}),
    segments,
    isComplete: hasEndlist || isVod,
  }
}

// ---------------------------------------------------------------------------
// Internal: resolve KeyRef for a specific sequence number
// ---------------------------------------------------------------------------

type ActiveKey = KeyRef & { _explicit?: boolean; _ivBytes?: Uint8Array | null }

function resolveKeyForSeq(key: ActiveKey, seq: number): KeyRef {
  const iv = key._explicit && key._ivBytes ? key._ivBytes : seqNumberIv(seq)
  return { method: 'AES-128', uri: key.uri, iv }
}
