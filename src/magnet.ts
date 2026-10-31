import { TorrentError } from './bencode.js'
import type { TorrentIdentity } from './metadata.js'

export interface FileSelection {
  start: number
  end: number
}
export interface Magnet {
  identity: TorrentIdentity
  name?: string
  trackers: string[]
  webSeeds: string[]
  exactSources: string[]
  acceptableSources: string[]
  peers: string[]
  /** Inclusive ranges, never expanded into an attacker-sized array. */
  selectOnly?: FileSelection[]
  /** All parameters, including unknown extensions and their order. */
  parameters: readonly (readonly [string, string])[]
}
function fail(message: string): never {
  throw new TorrentError('magnet', message)
}
export function normalizeBtih(value: string): string | null {
  if (/^[a-f0-9]{40}$/i.test(value)) return value.toLowerCase()
  if (!/^[a-z2-7]{32}$/i.test(value)) return null
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let accumulator = 0
  let bits = 0
  let result = ''
  for (const char of value.toUpperCase()) {
    accumulator = (accumulator << 5) | alphabet.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      result += ((accumulator >>> bits) & 255).toString(16).padStart(2, '0')
      accumulator &= (1 << bits) - 1
    }
  }
  return result
}
export function parseMagnet(uri: string): Magnet {
  if (uri.length > 65536) fail('Magnet exceeds size limit')
  if (!/^magnet:\?/i.test(uri) || uri.includes('#')) fail('Invalid magnet URI')
  // URLSearchParams tolerates malformed escapes; identities must not use that recovery.
  try {
    decodeURIComponent(uri.replace(/\+/g, ' '))
  } catch {
    fail('Invalid magnet encoding')
  }
  const parameters = [...new URLSearchParams(uri.slice(8))]
  if (parameters.length > 1024) fail('Too many magnet parameters')
  const all = (name: string) =>
    parameters.filter(([key]) => key === name).map(([, value]) => value)
  let v1: string | undefined
  let v2: string | undefined
  for (const topic of all('xt')) {
    if (/^urn:btih:/i.test(topic)) {
      const hash = normalizeBtih(topic.slice(9))
      if (!hash || (v1 && hash !== v1)) fail('Invalid or conflicting btih')
      v1 = hash
    } else if (/^urn:btmh:/i.test(topic)) {
      const hash = topic.slice(9).toLowerCase()
      if (!/^1220[a-f0-9]{64}$/.test(hash))
        fail('Unsupported or invalid btmh multihash')
      if (v2 && v2 !== hash.slice(4)) fail('Conflicting btmh')
      v2 = hash.slice(4)
    }
  }
  if (!v1 && !v2) fail('Magnet contains no supported identity')
  const identity: TorrentIdentity =
    v1 && v2
      ? { kind: 'hybrid', sha1: v1, sha256: v2 }
      : v1
        ? { kind: 'v1', sha1: v1 }
        : { kind: 'v2', sha256: v2 as string }
  const selections = all('so')
  if (selections.length > 1) fail('Multiple file selections')
  const selectOnly =
    selections[0] === undefined
      ? undefined
      : selections[0].split(',').map((value) => {
          if (!/^(0|[1-9][0-9]*)(-(0|[1-9][0-9]*))?$/.test(value))
            fail('Invalid file selection')
          const [first, last] = value.split('-')
          const start = Number(first)
          const end = last === undefined ? start : Number(last)
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            end < start
          )
            fail('Invalid selection range')
          return { start, end }
        })
  return {
    identity,
    name: all('dn')[0],
    trackers: all('tr'),
    webSeeds: all('ws'),
    exactSources: all('xs'),
    acceptableSources: all('as'),
    peers: all('x.pe'),
    selectOnly,
    parameters,
  }
}
export function encodeMagnet(
  magnet: Pick<Magnet, 'identity'> & Partial<Omit<Magnet, 'identity'>>
): string {
  const parameters = new URLSearchParams()
  const identity = magnet.identity
  if (identity.kind !== 'v2')
    parameters.append('xt', `urn:btih:${identity.sha1}`)
  if (identity.kind !== 'v1')
    parameters.append('xt', `urn:btmh:1220${identity.sha256}`)
  if (magnet.name !== undefined) parameters.append('dn', magnet.name)
  for (const [key, values] of [
    ['tr', magnet.trackers],
    ['ws', magnet.webSeeds],
    ['xs', magnet.exactSources],
    ['as', magnet.acceptableSources],
    ['x.pe', magnet.peers],
  ] as const)
    for (const value of values ?? []) parameters.append(key, value)
  if (magnet.selectOnly)
    parameters.append(
      'so',
      magnet.selectOnly
        .map(({ start, end }) =>
          start === end ? `${start}` : `${start}-${end}`
        )
        .join(',')
    )
  const known = new Set(['xt', 'dn', 'tr', 'ws', 'xs', 'as', 'x.pe', 'so'])
  for (const [key, value] of magnet.parameters ?? [])
    if (!known.has(key) || (key === 'xt' && !/^urn:bt(ih|mh):/i.test(value)))
      parameters.append(key, value)
  const uri = `magnet:?${parameters}`
  parseMagnet(uri)
  return uri
}
