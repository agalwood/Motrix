import { createHash } from 'node:crypto'
import path from 'node:path'
import type { LegacyReason } from '@shared/schemas/legacy-import'

export const MAX_LEGACY_BYTES = 8 * 1024 * 1024
export const MAX_LEGACY_ITEMS = 10000
const MAX_LINE = 16384
const OPTIONS = new Set([
  'gid',
  'dir',
  'out',
  'select-file',
  'pause',
  'continue',
  'max-connection-per-server',
  'split',
  'min-split-size',
  'max-download-limit',
  'max-upload-limit',
  'bt-seed-unverified',
  'seed-time',
  'seed-ratio',
  'bt-save-metadata',
  'bt-metadata-only',
  'check-integrity',
  'allow-overwrite',
  'auto-file-renaming',
  'file-allocation',
])

export interface LegacySessionEntry {
  itemKey: string
  digest: string
  gid: string | null
  uris: string[]
  options: Record<string, string>
  reason: LegacyReason | null
}

export function digestBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** aria2 text sessions: each URI line is followed by indented key=value options. */
export function parseLegacySession(bytes: Uint8Array): LegacySessionEntry[] {
  if (bytes.byteLength > MAX_LEGACY_BYTES)
    throw new Error('legacyImport.tooLarge')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.includes('\0')) throw new Error('legacyImport.invalidSource')
  const entries: LegacySessionEntry[] = []
  let lines: string[] = []
  const flush = () => {
    if (!lines.length) return
    if (entries.length >= MAX_LEGACY_ITEMS)
      throw new Error('legacyImport.tooLarge')
    const raw = lines.join('\n')
    const uris = lines[0].trim().split(/\t+/).filter(Boolean)
    const options: Record<string, string> = Object.create(null)
    let reason: LegacyReason | null =
      lines.some((line) => line.length > MAX_LINE) || uris.length > 16
        ? 'invalid-record'
        : null
    for (const line of lines.slice(1)) {
      const match = /^\s+([a-z0-9-]+)=(.*)$/.exec(line)
      if (!match) {
        reason = 'invalid-record'
        continue
      }
      if (!OPTIONS.has(match[1])) reason = 'unsupported-options'
      else options[match[1]] = match[2]
    }
    const gid =
      options.gid && /^[a-f\d]{16}$/i.test(options.gid)
        ? options.gid.toLowerCase()
        : null
    if (options.gid && !gid) reason = 'invalid-record'
    const digest = digestBytes(raw)
    const itemKey = gid ? `gid:${gid}` : `entry:${digest}`
    entries.push({ itemKey, digest, gid, uris, options, reason })
    lines = []
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    if (!/^\s/.test(line)) flush()
    if (!lines.length && /^\s/.test(line)) {
      lines = ['invalid:', line]
    } else lines.push(line)
  }
  flush()
  const counts = new Map<string, number>()
  for (const entry of entries)
    counts.set(entry.itemKey, (counts.get(entry.itemKey) ?? 0) + 1)
  for (const entry of entries)
    if ((counts.get(entry.itemKey) ?? 0) > 1) entry.reason = 'invalid-record'
  return entries
}

export function safeLegacyComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
    !/[<>:"/\\|?*]/.test(value) &&
    !/[. ]$/.test(value) &&
    !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(value)
  )
}

export function safeLegacyOutput(dir: string, name: string): string | null {
  if (
    !path.isAbsolute(dir) ||
    dir.includes('\0') ||
    dir.length > 4096 ||
    !safeLegacyComponent(name)
  )
    return null
  const root = path.resolve(dir)
  if (root === path.parse(root).root) return null
  return path.join(root, name)
}

/** Validate bencode complexity before allowing a third-party decoder to recurse. */
export function validateLegacyBencode(bytes: Uint8Array): void {
  if (bytes.length > MAX_LEGACY_BYTES) throw new Error('legacyImport.tooLarge')
  let cursor = 0
  let nodes = 0
  const visit = (depth: number) => {
    if (depth > 32 || ++nodes > 100000)
      throw new Error('legacyImport.invalidSource')
    const char = bytes[cursor++]
    if (char === 100 || char === 108) {
      while (bytes[cursor] !== 101) {
        if (cursor >= bytes.length)
          throw new Error('legacyImport.invalidSource')
        visit(depth + 1)
      }
      cursor++
    } else if (char === 105) {
      const start = cursor
      while (bytes[cursor] !== 101 && cursor < bytes.length) cursor++
      const number = new TextDecoder().decode(bytes.slice(start, cursor))
      if (
        number.length > 20 ||
        !/^-?\d+$/.test(number) ||
        !Number.isSafeInteger(Number(number)) ||
        cursor >= bytes.length
      )
        throw new Error('legacyImport.invalidSource')
      cursor++
    } else if (char >= 48 && char <= 57) {
      let length = char - 48
      let digits = 1
      while (bytes[cursor] !== 58) {
        const next = bytes[cursor++]
        if (++digits > 8 || next < 48 || next > 57)
          throw new Error('legacyImport.invalidSource')
        length = length * 10 + next - 48
      }
      cursor++
      if (length > bytes.length - cursor)
        throw new Error('legacyImport.invalidSource')
      cursor += length
    } else throw new Error('legacyImport.invalidSource')
  }
  visit(0)
  if (cursor !== bytes.length) throw new Error('legacyImport.invalidSource')
}
