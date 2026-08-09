import {
  type ByteRange,
  type InitSegment,
  MediaParseError,
  type MediaPart,
  resolveUri,
  type SegmentPlan,
} from './segment-plan'

export function parseDash(
  xml: string,
  mpdUrl: string
): { video: SegmentPlan; audio?: SegmentPlan } {
  if (/<MPD\b[^>]*\btype\s*=\s*"dynamic"/i.test(xml)) {
    throw new MediaParseError('unsupported-live', 'dynamic (live) MPD')
  }
  if (/<ContentProtection\b/i.test(xml)) {
    throw new MediaParseError('unsupported-encryption', 'DRM-protected MPD')
  }

  const mpdBaseUrl = extractMpdBaseUrl(xml, mpdUrl)

  const periodMatch = /<Period\b([^>]*)>([\s\S]*?)<\/Period>/i.exec(xml)
  const periodAttrs = periodMatch?.[1] ?? ''
  const periodBody = periodMatch?.[2] ?? xml

  const mpdDuration = parseDuration(
    attrVal(/<MPD\b[^>]*>/i.exec(xml)?.[0] ?? '', 'mediaPresentationDuration')
  )
  const periodDuration =
    parseDuration(attrVal(periodAttrs, 'duration')) ?? mpdDuration
  const periodBaseUrl = resolveLevelBaseUrl(periodBody, mpdBaseUrl)

  const adaptationSets = extractAdaptationSets(periodBody)

  const videoSets = adaptationSets.filter((a) => isMediaType(a.attrs, 'video'))
  const audioSets = adaptationSets.filter((a) => isMediaType(a.attrs, 'audio'))

  if (videoSets.length === 0) {
    throw new MediaParseError('unsupported-master', 'no video representation')
  }

  const video = pickBestPlan(videoSets, periodBaseUrl, periodDuration, mpdUrl)
  if (video === null) {
    throw new MediaParseError('unsupported-master', 'no video representation')
  }

  let audio: SegmentPlan | undefined
  if (audioSets.length > 0) {
    const audioPlan = pickBestPlan(
      audioSets,
      periodBaseUrl,
      periodDuration,
      mpdUrl
    )
    if (audioPlan !== null) {
      audio = audioPlan
    }
  }

  return { video, audio }
}

// ── Attribute helpers ──────────────────────────────────────────────────────────

function attrVal(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i')
  return re.exec(tag)?.[1]
}

function isMediaType(attrs: string, type: 'video' | 'audio'): boolean {
  const ct = attrVal(attrs, 'contentType')
  if (ct) return ct.toLowerCase().startsWith(type)
  const mt = attrVal(attrs, 'mimeType')
  if (mt) return mt.toLowerCase().startsWith(type)
  return false
}

// ── BaseURL resolution ─────────────────────────────────────────────────────────

/**
 * Extract a top-level BaseURL from the immediate children of the given XML
 * body (Period/AdaptationSet/Representation body), then resolve it against
 * the parent base URL.  Only reads the FIRST <BaseURL> that is a direct child
 * (not nested inside another element at depth>1 relative to the body root).
 */
function resolveLevelBaseUrl(body: string, parentBase: string): string {
  // Match the first <BaseURL> that is not inside a nested element.
  // We look for the element in the direct content – a simple regex suffices
  // because DASH BaseURL elements cannot nest.
  const m = /<BaseURL[^>]*>([^<]*)<\/BaseURL>/i.exec(body)
  if (!m) return parentBase
  const href = m[1].trim()
  if (!href) return parentBase
  return resolveUri(parentBase, href)
}

function extractMpdBaseUrl(xml: string, mpdUrl: string): string {
  // MPD-level BaseURL is a direct child of <MPD>
  const mpdBodyMatch = /<MPD\b[^>]*>([\s\S]*?)<\/MPD>/i.exec(xml)
  const mpdBody = mpdBodyMatch?.[1] ?? ''
  return resolveLevelBaseUrl(mpdBody, mpdUrl)
}

// ── AdaptationSet extraction ───────────────────────────────────────────────────

interface AdaptationSetInfo {
  attrs: string
  body: string
}

function extractAdaptationSets(periodBody: string): AdaptationSetInfo[] {
  const sets: AdaptationSetInfo[] = []
  const re = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi
  for (const m of periodBody.matchAll(re)) {
    sets.push({ attrs: m[1] ?? '', body: m[2] ?? '' })
  }
  return sets
}

// ── Representation selection ───────────────────────────────────────────────────

interface RepInfo {
  id: string
  bandwidth: number
  attrs: string
  body: string
}

function extractRepresentations(adaptationBody: string): RepInfo[] {
  const reps: RepInfo[] = []
  const re = /<Representation\b([^>]*?)>([\s\S]*?)<\/Representation>/gi
  for (const m of adaptationBody.matchAll(re)) {
    const attrs = m[1] ?? ''
    const body = m[2] ?? ''
    const id = attrVal(attrs, 'id') ?? ''
    const bw = Number(attrVal(attrs, 'bandwidth') ?? '0')
    reps.push({ id, bandwidth: bw, attrs, body })
  }
  // Also handle self-closing <Representation ... />
  const selfRe = /<Representation\b([^>]*?)\/>/gi
  for (const m of adaptationBody.matchAll(selfRe)) {
    const attrs = m[1] ?? ''
    const id = attrVal(attrs, 'id') ?? ''
    const bw = Number(attrVal(attrs, 'bandwidth') ?? '0')
    reps.push({ id, bandwidth: bw, attrs, body: '' })
  }
  return reps
}

// ── Period duration parsing ────────────────────────────────────────────────────

function parseDuration(iso?: string): number | undefined {
  if (!iso) return undefined
  // PT#H#M#S or P#Y#M#DT#H#M#S
  const m =
    /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/i.exec(
      iso
    )
  if (!m) return undefined
  const years = Number(m[1] ?? 0)
  const months = Number(m[2] ?? 0)
  const days = Number(m[3] ?? 0)
  const hours = Number(m[4] ?? 0)
  const minutes = Number(m[5] ?? 0)
  const seconds = Number(m[6] ?? 0)
  return (
    years * 31536000 +
    months * 2592000 +
    days * 86400 +
    hours * 3600 +
    minutes * 60 +
    seconds
  )
}

// ── URI template filling ───────────────────────────────────────────────────────

/**
 * Fill DASH URI template tokens:
 *   $$        → $
 *   $RepresentationID$   → id (no numeric formatting)
 *   $Number[%0Nd]$       → number (with optional printf-style padding)
 *   $Bandwidth[%0Nd]$    → bandwidth (with optional printf-style padding)
 *   $Time[%0Nd]$         → time (with optional printf-style padding)
 */
function fillUriTemplate(
  template: string,
  id: string,
  number: number,
  bandwidth: number,
  time: number
): string {
  return template.replace(
    /\$(RepresentationID|Number|Bandwidth|Time|SubNumber)?(?:%0(\d+)([diouxX]))?\$/g,
    (_match, token: string | undefined, width: string | undefined) => {
      if (!token) return '$' // $$
      if (token === 'RepresentationID') return id
      let val: number
      if (token === 'Number' || token === 'SubNumber') val = number
      else if (token === 'Bandwidth') val = bandwidth
      else val = time // Time
      if (width) {
        return String(val).padStart(Number(width), '0')
      }
      return String(val)
    }
  )
}

// ── Byte-range parsing ─────────────────────────────────────────────────────────

function parseRange(range: string): ByteRange {
  const parts = range.split('-')
  const start = Number(parts[0])
  const end = Number(parts[1])
  return { offset: start, length: end - start + 1 }
}

// ── Segment addressing modes ───────────────────────────────────────────────────

interface SegmentTemplateAttrs {
  timescale: number
  startNumber: number
  duration?: number
  initialization?: string
  media: string
}

function parseSegmentTemplateAttrs(tag: string): SegmentTemplateAttrs {
  return {
    timescale: Number(attrVal(tag, 'timescale') ?? '1'),
    startNumber: Number(attrVal(tag, 'startNumber') ?? '1'),
    duration:
      attrVal(tag, 'duration') !== undefined
        ? Number(attrVal(tag, 'duration'))
        : undefined,
    initialization: attrVal(tag, 'initialization'),
    media: attrVal(tag, 'media') ?? '',
  }
}

interface SEntry {
  t?: number
  d: number
  r: number
}

function parseSegmentTimeline(timelineBody: string): SEntry[] {
  const entries: SEntry[] = []
  const re = /<S\b([^>]*)\/?\s*>/gi
  for (const m of timelineBody.matchAll(re)) {
    const attrs = m[1] ?? ''
    const t = attrVal(attrs, 't')
    const d = Number(attrVal(attrs, 'd') ?? '0')
    const r = Number(attrVal(attrs, 'r') ?? '0')
    entries.push({ t: t !== undefined ? Number(t) : undefined, d, r })
  }
  return entries
}

function expandTimeline(
  entries: SEntry[],
  periodDurationSec: number | undefined,
  timescale: number,
  startNumber: number,
  id: string,
  bandwidth: number,
  mediaTemplate: string,
  base: string,
  _mpdUrl: string
): MediaPart[] {
  const parts: MediaPart[] = []
  let time = 0
  let seq = startNumber
  let idx = 0

  for (let i = 0; i < entries.length; i++) {
    const s = entries[i]
    if (s.t !== undefined) time = s.t

    let reps: number
    if (s.r >= 0) {
      reps = s.r // r=N means N+1 segments; loop 0..r (inclusive)
    } else {
      // r=-1: fill until next S@t or period end
      const nextT = entries[i + 1]?.t
      if (nextT !== undefined) {
        reps = Math.round((nextT - time) / s.d) - 1
      } else if (periodDurationSec !== undefined) {
        const periodEndTs = Math.round(periodDurationSec * timescale)
        reps = Math.round((periodEndTs - time) / s.d) - 1
      } else {
        reps = 0
      }
      if (reps < 0) reps = 0
    }

    for (let j = 0; j <= reps; j++) {
      const url = resolveUri(
        base,
        fillUriTemplate(mediaTemplate, id, seq, bandwidth, time)
      )
      // Also resolve against mpdUrl in case base is mpdUrl itself
      parts.push({ url, index: idx++ })
      time += s.d
      seq++
    }
  }

  return parts
}

function buildSegmentTemplatePlan(
  templateTag: string,
  templateBody: string,
  rep: RepInfo,
  base: string,
  periodDurationSec: number | undefined,
  mpdUrl: string
): SegmentPlan {
  const tmpl = parseSegmentTemplateAttrs(templateTag)
  const id = rep.id
  const bw = rep.bandwidth

  let init: InitSegment | undefined
  if (tmpl.initialization) {
    const initUrl = resolveUri(
      base,
      fillUriTemplate(tmpl.initialization, id, 0, bw, 0)
    )
    init = { url: initUrl }
  }

  const timelineMatch =
    /<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/i.exec(templateBody)

  let segments: MediaPart[]

  if (timelineMatch) {
    const entries = parseSegmentTimeline(timelineMatch[1] ?? '')
    segments = expandTimeline(
      entries,
      periodDurationSec,
      tmpl.timescale,
      tmpl.startNumber,
      id,
      bw,
      tmpl.media,
      base,
      mpdUrl
    )
  } else if (tmpl.duration !== undefined && periodDurationSec !== undefined) {
    const count = Math.ceil(
      (periodDurationSec * tmpl.timescale) / tmpl.duration
    )
    segments = []
    for (let i = 0; i < count; i++) {
      const number = tmpl.startNumber + i
      const time = i * tmpl.duration
      const url = resolveUri(
        base,
        fillUriTemplate(tmpl.media, id, number, bw, time)
      )
      segments.push({ url, index: i })
    }
  } else {
    segments = []
  }

  return { container: 'fmp4', init, segments, isComplete: true }
}

function buildSegmentListPlan(listBody: string, base: string): SegmentPlan {
  let init: InitSegment | undefined
  const initMatch = /<Initialization\b([^>]*)\/?\s*>/i.exec(listBody)
  if (initMatch) {
    const initAttrs = initMatch[1] ?? ''
    const srcUrl = attrVal(initAttrs, 'sourceURL')
    if (srcUrl) {
      const url = resolveUri(base, srcUrl)
      const rangeStr = attrVal(initAttrs, 'range')
      init = { url, byteRange: rangeStr ? parseRange(rangeStr) : undefined }
    }
  }

  const segments: MediaPart[] = []
  let idx = 0
  const segRe = /<SegmentURL\b([^>]*)\/?\s*>/gi
  for (const m of listBody.matchAll(segRe)) {
    const attrs = m[1] ?? ''
    const media = attrVal(attrs, 'media')
    if (!media) continue
    const url = resolveUri(base, media)
    const rangeStr = attrVal(attrs, 'mediaRange')
    segments.push({
      url,
      index: idx++,
      byteRange: rangeStr ? parseRange(rangeStr) : undefined,
    })
  }

  return { container: 'fmp4', init, segments, isComplete: true }
}

function buildSingleFilePlan(baseUrl: string): SegmentPlan {
  return {
    container: 'single',
    init: undefined,
    segments: [{ url: baseUrl, index: 0 }],
    isComplete: true,
  }
}

// ── Inherited SegmentTemplate from AdaptationSet ───────────────────────────────

/**
 * Find the first SegmentTemplate in a body (AdaptationSet or Period level).
 * Returns { tag, body } where body is the inner content (SegmentTimeline etc).
 */
function findSegmentTemplate(
  body: string
): { tag: string; body: string } | undefined {
  const m = /<(SegmentTemplate)\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/i.exec(
    body
  )
  if (m) {
    // Reconstruct a pseudo-tag with the attrs for parseSegmentTemplateAttrs
    return { tag: `<SegmentTemplate ${m[2] ?? ''}>`, body: m[3] ?? '' }
  }
  // Self-closing
  const sc = /<SegmentTemplate\b([^>]*)\/>/i.exec(body)
  if (sc) {
    return { tag: `<SegmentTemplate ${sc[1] ?? ''}>`, body: '' }
  }
  return undefined
}

function findSegmentList(body: string): string | undefined {
  const m = /<SegmentList\b[^>]*>([\s\S]*?)<\/SegmentList>/i.exec(body)
  return m ? m[1] : undefined
}

function findBaseUrlInBody(body: string): string | undefined {
  // child <BaseURL> element
  const m = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/i.exec(body)
  if (m) return m[1].trim()
  return undefined
}

// ── Plan builder ───────────────────────────────────────────────────────────────

function buildRepPlan(
  rep: RepInfo,
  _adSetAttrs: string,
  adSetBody: string,
  setBase: string,
  periodDurationSec: number | undefined,
  mpdUrl: string
): SegmentPlan {
  // Determine rep-level base URL
  const repBaseUrlHref =
    findBaseUrlInBody(rep.body) ?? attrVal(rep.attrs, 'baseURL')
  const repBase = repBaseUrlHref ? resolveUri(setBase, repBaseUrlHref) : setBase

  // 1. SegmentTemplate in Representation body
  const repTemplate = findSegmentTemplate(rep.body)
  if (repTemplate) {
    return buildSegmentTemplatePlan(
      repTemplate.tag,
      repTemplate.body,
      rep,
      repBase,
      periodDurationSec,
      mpdUrl
    )
  }

  // 2. SegmentList in Representation body
  const repListBody = findSegmentList(rep.body)
  if (repListBody !== undefined) {
    return buildSegmentListPlan(repListBody, repBase)
  }

  // 3. SegmentTemplate inherited from AdaptationSet
  const setTemplate = findSegmentTemplate(adSetBody)
  if (setTemplate) {
    return buildSegmentTemplatePlan(
      setTemplate.tag,
      setTemplate.body,
      rep,
      repBase,
      periodDurationSec,
      mpdUrl
    )
  }

  // 4. SegmentList inherited from AdaptationSet
  const setListBody = findSegmentList(adSetBody)
  if (setListBody !== undefined) {
    return buildSegmentListPlan(setListBody, repBase)
  }

  // 5. SegmentBase or plain BaseURL → single file
  return buildSingleFilePlan(repBase)
}

// ── Top-level plan picker ──────────────────────────────────────────────────────

function pickBestPlan(
  adaptationSets: AdaptationSetInfo[],
  periodBase: string,
  periodDurationSec: number | undefined,
  mpdUrl: string
): SegmentPlan | null {
  let best: {
    rep: RepInfo
    setAttrs: string
    setBody: string
    setBase: string
  } | null = null

  for (const set of adaptationSets) {
    const setBase = resolveLevelBaseUrl(set.body, periodBase)
    const reps = extractRepresentations(set.body)
    for (const rep of reps) {
      if (!best || rep.bandwidth > best.rep.bandwidth) {
        best = { rep, setAttrs: set.attrs, setBody: set.body, setBase }
      }
    }
  }

  if (!best) return null

  return buildRepPlan(
    best.rep,
    best.setAttrs,
    best.setBody,
    best.setBase,
    periodDurationSec,
    mpdUrl
  )
}
