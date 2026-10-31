import { createHash } from 'node:crypto'
import path from 'node:path'
import { BDictionary, type BValue, decode } from '@motrix/torrent/bencode'
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
  // Declarative options emitted by the v1.8.19 bundled engine even when the
  // user did not customize a task. None is applied during scan or import.
  'pause-metadata',
  'follow-torrent',
  'follow-metalink',
  'enable-peer-exchange',
  'bt-enable-lpd',
  'bt-force-encryption',
  'bt-load-saved-metadata',
  'bt-tracker',
])

const PROXY_PREFIXES = ['all-proxy', 'http-proxy', 'https-proxy', 'ftp-proxy']
const LEGACY_PROXY_OPTIONS = new Set([
  ...PROXY_PREFIXES.flatMap((key) => [key, `${key}-user`, `${key}-passwd`]),
  'no-proxy',
  'proxy-method',
])

/** Values remain private to the parser; only filtered names enter public records. */
export const LEGACY_REQUEST_OPTIONS = new Set([
  'header',
  'referer',
  'http-user',
  'http-passwd',
  'user-agent',
  'no-netrc',
])

type LegacyRequestValues = Readonly<Record<string, readonly string[]>>
type LegacyRequestKind = 'http' | 'bt' | 'magnet' | 'unknown'
const privateRequestValues = new WeakMap<
  LegacySessionEntry,
  LegacyRequestValues
>()
const privateIgnoredOptions = new WeakMap<
  LegacySessionEntry,
  readonly string[]
>()
const EMPTY_REQUEST_VALUES: LegacyRequestValues = Object.freeze(
  Object.create(null)
)

export function getLegacyRequestValues(
  entry: LegacySessionEntry
): LegacyRequestValues {
  return privateRequestValues.get(entry) ?? EMPTY_REQUEST_VALUES
}

function safeOptionName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9-]+$/.test(name)
}

function validRequestText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_LINE &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    }) &&
    !/[\ud800-\udfff]/u.test(value)
  )
}

/** Resolve aria2 singleton precedence and cumulative headers once per entry. */
export function resolveLegacyRequestSettings(
  entry: LegacySessionEntry,
  system: Readonly<Record<string, unknown>>,
  kind: LegacyRequestKind
): {
  values: LegacyRequestValues
  requestOptions: string[]
  ignoredOptions: string[]
} {
  const task = getLegacyRequestValues(entry)
  const values: Record<string, string[]> = Object.create(null)
  const ignored = new Set(
    privateIgnoredOptions.get(entry) ?? entry.ignoredOptions
  )
  const ignore = (key: string) => {
    if (safeOptionName(key) && ignored.size < 64) ignored.add(key)
  }
  const raw = (key: string): readonly unknown[] => {
    if (Object.hasOwn(task, key)) return task[key]
    const value = system[key]
    return value === undefined || value === null
      ? []
      : Array.isArray(value)
        ? value
        : [value]
  }
  for (const key of Object.keys(system))
    if (
      !OPTIONS.has(key) &&
      !LEGACY_REQUEST_OPTIONS.has(key) &&
      (!LEGACY_PROXY_OPTIONS.has(key) || system[key] !== '')
    )
      ignore(key)
  for (const key of LEGACY_REQUEST_OPTIONS) {
    if (key === 'header') continue
    const list = raw(key)
    if (!list.length) continue
    const value = list.at(-1)
    if (key === 'no-netrc') {
      if (value !== 'true' && value !== true) ignore(key)
      continue
    }
    if (kind !== 'http') {
      if (value !== '') ignore(key)
      continue
    }
    if (!validRequestText(value)) {
      ignore(key)
      continue
    }
    if (
      (key === 'referer' && value === '*') ||
      (key === 'http-user' && value.includes(':'))
    ) {
      ignore(key)
      continue
    }
    values[key] = [
      value.trim() === '' && !key.endsWith('-user') && !key.endsWith('-passwd')
        ? ''
        : value,
    ]
  }
  const inheritedHeaders =
    system.header == null
      ? []
      : Array.isArray(system.header)
        ? system.header
        : [system.header]
  const headers = [...inheritedHeaders, ...(task.header ?? [])]
  if (kind !== 'http') {
    if (headers.some((value) => value !== '')) ignore('header')
  } else {
    const byName = new Map<string, string[]>()
    for (const line of headers) {
      if (typeof line === 'string' && !line.trim()) continue
      if (!validRequestText(line)) {
        ignore('header')
        continue
      }
      const colon = line.indexOf(':')
      const name = line.slice(0, colon).trim().toLowerCase()
      if (
        colon <= 0 ||
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
        [
          'range',
          'if-range',
          'if-match',
          'accept-encoding',
          'host',
          'connection',
          'content-length',
          'transfer-encoding',
          'proxy-authorization',
        ].includes(name)
      ) {
        ignore('header')
        continue
      }
      const group = byName.get(name) ?? []
      group.push(line)
      byName.set(name, group)
    }
    for (const [name, group] of byName) {
      if (group.length > 1) {
        ignore('header')
        byName.delete(name)
      }
    }
    for (const [option, header] of [
      ['referer', 'referer'],
      ['http-user', 'authorization'],
    ] as const) {
      if (!values[option]?.[0] || !byName.has(header)) continue
      ignore(option)
      if (option === 'http-user') {
        if (values['http-passwd']?.[0]) ignore('http-passwd')
        delete values['http-passwd']
      }
      delete values[option]
    }
    if (!values['http-user']?.[0] && values['http-passwd']?.[0]) {
      ignore('http-passwd')
      delete values['http-passwd']
    }
    const accepted = [...byName.values()].flat()
    if (accepted.length) values.header = accepted
  }
  return {
    values,
    requestOptions: Object.keys(values).filter(
      (key) => key !== 'user-agent' && values[key].some((value) => value !== '')
    ),
    ignoredOptions: [...ignored],
  }
}

export interface LegacySessionEntry {
  itemKey: string
  digest: string
  gid: string | null
  uris: string[]
  options: Record<string, string>
  optionPairs: Array<readonly [string, string]>
  requestOptions: string[]
  ignoredOptions: string[]
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
    const optionPairs: Array<readonly [string, string]> = []
    const requestValues: Record<string, string[]> = Object.create(null)
    const ignoredOptions = new Set<string>()
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
      const [, key, value] = match
      if (LEGACY_REQUEST_OPTIONS.has(key)) {
        if (key === 'no-netrc') {
          if (value === 'true') options[key] = value
          else delete options[key]
        }
        requestValues[key] ??= []
        requestValues[key].push(value)
      } else if (!OPTIONS.has(key)) {
        if (
          safeOptionName(key) &&
          ignoredOptions.size < 64 &&
          (!LEGACY_PROXY_OPTIONS.has(key) || value !== '')
        )
          ignoredOptions.add(key)
      } else {
        optionPairs.push([key, value])
        options[key] = value
      }
    }
    const gid =
      options.gid && /^[a-f\d]{16}$/i.test(options.gid)
        ? options.gid.toLowerCase()
        : null
    if (options.gid && !gid) reason = 'invalid-record'
    const digest = digestBytes(raw)
    const itemKey = gid ? `gid:${gid}` : `entry:${digest}`
    const entry: LegacySessionEntry = {
      itemKey,
      digest,
      gid,
      uris,
      options,
      optionPairs,
      requestOptions: [],
      ignoredOptions: [...ignoredOptions],
      reason,
    }
    privateRequestValues.set(entry, requestValues)
    privateIgnoredOptions.set(entry, entry.ignoredOptions)
    const request = resolveLegacyRequestSettings(
      entry,
      {},
      /^https?:\/\//i.test(uris[0] ?? '') ? 'http' : 'bt'
    )
    entry.requestOptions = request.requestOptions
    entry.ignoredOptions = request.ignoredOptions
    if (!entry.reason && request.requestOptions.length)
      entry.reason = 'request-settings-required'
    entries.push(entry)
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

export function safeLegacyDirectory(dir: string): string | null {
  if (!path.isAbsolute(dir) || dir.includes('\0') || dir.length > 4096)
    return null
  let root = path.resolve(dir)
  // Drive-letter casing has no identity distinction, even in a case-sensitive
  // NTFS directory. Keep persisted Windows paths aligned with realpath.
  if (process.platform === 'win32' && /^[a-z]:\\/.test(root))
    root = root[0].toUpperCase() + root.slice(1)
  return root === path.parse(root).root ? null : root
}

export function safeLegacyOutput(dir: string, name: string): string | null {
  const root = safeLegacyDirectory(dir)
  return root && safeLegacyComponent(name) ? path.join(root, name) : null
}

/** Apply the legacy import budget through the shared binary-safe decoder. */
export function validateLegacyBencode(bytes: Uint8Array): void {
  if (bytes.length > MAX_LEGACY_BYTES) throw new Error('legacyImport.tooLarge')
  try {
    const { value } = decode(bytes, {
      maxBytes: MAX_LEGACY_BYTES,
      maxDepth: 32,
      maxNodes: 100000,
      maxIntegerDigits: 16,
      allowUnsortedKeys: true,
    })
    const safeIntegers = (value: BValue): void => {
      if (
        typeof value === 'bigint' &&
        (value > BigInt(Number.MAX_SAFE_INTEGER) ||
          value < BigInt(Number.MIN_SAFE_INTEGER))
      )
        throw new Error('Unsafe legacy integer')
      if (Array.isArray(value)) value.forEach(safeIntegers)
      if (value instanceof BDictionary)
        for (const [, child] of value.entries) safeIntegers(child)
    }
    safeIntegers(value)
  } catch {
    throw new Error('legacyImport.invalidSource')
  }
}
