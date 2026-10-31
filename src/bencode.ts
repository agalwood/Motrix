/** Binary-safe bencode. Byte strings borrow the input; callers must not mutate it. */
export type BValue = bigint | Uint8Array | BValue[] | BDictionary
export type BInput =
  | number
  | bigint
  | string
  | Uint8Array
  | BInput[]
  | BDictionary
  | Map<string | Uint8Array, BInput>
  | { [key: string]: BInput }
export class TorrentError extends Error {
  constructor(
    readonly code: 'bencode' | 'limit' | 'metadata' | 'version' | 'magnet',
    message: string
  ) {
    super(message)
    this.name = 'TorrentError'
  }
}
export const utf8 = new TextEncoder()
export const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true })
export function hex(bytes: Uint8Array): string {
  const digits = '0123456789abcdef'
  const encoded = new Uint8Array(bytes.length * 2)
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number
    encoded[i * 2] = digits.charCodeAt(byte >>> 4)
    encoded[i * 2 + 1] = digits.charCodeAt(byte & 15)
  }
  return textDecoder.decode(encoded)
}
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = (a[i] as number) - (b[i] as number)
    if (difference) return difference
  }
  return a.length - b.length
}
type DictionaryEntry = readonly [Uint8Array, BValue]
export class BDictionary {
  readonly entries: readonly DictionaryEntry[]
  // One reference per key, bounded by the decoder's node budget. Keep binary
  // keys borrowed instead of expanding attacker-controlled keys into strings.
  readonly #index: readonly DictionaryEntry[]
  constructor(entries: readonly DictionaryEntry[]) {
    this.entries = entries
    const index = [...entries]
    index.sort(([a], [b]) => compareBytes(a, b))
    for (let i = 1; i < index.length; i++) {
      if (
        compareBytes(
          (index[i - 1] as DictionaryEntry)[0],
          (index[i] as DictionaryEntry)[0]
        ) === 0
      )
        throw new TorrentError('bencode', 'Duplicate dictionary key')
    }
    this.#index = index
  }
  get(key: string | Uint8Array): BValue | undefined {
    const bytes = typeof key === 'string' ? utf8.encode(key) : key
    let start = 0
    let end = this.#index.length
    while (start < end) {
      const middle = start + Math.floor((end - start) / 2)
      const [candidate, value] = this.#index[middle] as DictionaryEntry
      const order = compareBytes(candidate, bytes)
      if (order === 0) return value
      if (order < 0) start = middle + 1
      else end = middle
    }
    return undefined
  }
  has(key: string | Uint8Array): boolean {
    return this.get(key) !== undefined
  }
}
export interface BencodeLimits {
  maxBytes: number
  maxDepth: number
  maxNodes: number
  maxStringBytes: number
  maxIntegerDigits: number
}
export const DEFAULT_LIMITS: Readonly<BencodeLimits> = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 1_000_000,
  maxStringBytes: 64 * 1024 * 1024,
  maxIntegerDigits: 128,
})
export function limitsFor(options: Partial<BencodeLimits>): BencodeLimits {
  const limits = { ...DEFAULT_LIMITS, ...options }
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof BencodeLimits)[]) {
    const value = limits[key]
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TorrentError('limit', 'Invalid bencode limit')
  }
  // Recursive traversal is deliberately bounded even for caller-supplied limits.
  if (limits.maxDepth > 128)
    throw new TorrentError('limit', 'Maximum depth exceeds 128')
  return limits
}
export interface DecodeOptions extends Partial<BencodeLimits> {
  /** Compatibility for old v1 creators only. Duplicates and malformed numbers still fail. */
  allowUnsortedKeys?: boolean
}
export function decode(
  bytes: Uint8Array,
  options: DecodeOptions = {}
): {
  value: BValue
  infoRange?: readonly [number, number]
  canonical: boolean
  infoCanonical?: boolean
} {
  const limits = limitsFor(options)
  if (bytes.length > limits.maxBytes)
    throw new TorrentError('limit', 'Bencode exceeds byte limit')
  let cursor = 0
  let nodes = 0
  let canonical = true
  let unsortedDictionaries = 0
  let infoCanonical: boolean | undefined
  let infoRange: readonly [number, number] | undefined
  const fail = (message: string): never => {
    throw new TorrentError('bencode', `${message} at byte ${cursor}`)
  }
  const visit = (depth: number): BValue => {
    if (depth > limits.maxDepth || ++nodes > limits.maxNodes)
      throw new TorrentError('limit', 'Bencode complexity limit')
    const token = bytes[cursor++]
    if (token === 105) {
      const start = cursor
      while (cursor < bytes.length && bytes[cursor] !== 101) {
        if (cursor - start > limits.maxIntegerDigits)
          throw new TorrentError('limit', 'Integer digit limit')
        cursor++
      }
      if (cursor >= bytes.length) fail('Truncated integer')
      const value = textDecoder.decode(bytes.subarray(start, cursor++))
      if (!/^(0|-?[1-9][0-9]*)$/.test(value)) fail('Noncanonical integer')
      if (value.replace('-', '').length > limits.maxIntegerDigits)
        throw new TorrentError('limit', 'Integer digit limit')
      return BigInt(value)
    }
    if (token === 108 || token === 100) {
      const list: BValue[] = []
      const entries: [Uint8Array, BValue][] = []
      let previous: Uint8Array | undefined
      while (bytes[cursor] !== 101) {
        if (cursor >= bytes.length) fail('Truncated container')
        if (token === 108) list.push(visit(depth + 1))
        else {
          const key = visit(depth + 1)
          if (!(key instanceof Uint8Array))
            return fail('Dictionary key is not a byte string')
          if (previous) {
            const order = compareBytes(previous, key)
            if (order === 0) fail('Duplicate dictionary key')
            if (order > 0) {
              canonical = false
              unsortedDictionaries++
              if (!options.allowUnsortedKeys) fail('Unsorted dictionary keys')
            }
          }
          previous = key
          const start = cursor
          const before = unsortedDictionaries
          const value = visit(depth + 1)
          if (
            depth === 0 &&
            key.length === 4 &&
            key[0] === 105 &&
            key[1] === 110 &&
            key[2] === 102 &&
            key[3] === 111
          ) {
            infoRange = [start, cursor]
            infoCanonical = before === unsortedDictionaries
          }
          entries.push([key, value])
        }
      }
      cursor++
      return token === 108 ? list : new BDictionary(entries)
    }
    if (token === undefined || token < 48 || token > 57)
      return fail('Invalid token')
    let length = token - 48
    let digits = 1
    while (bytes[cursor] !== 58) {
      const digit = bytes[cursor++]
      if (digit === undefined || digit < 48 || digit > 57 || ++digits > 16)
        fail('Invalid string length')
      if (token === 48) fail('Noncanonical string length')
      length = length * 10 + (digit as number) - 48
      if (!Number.isSafeInteger(length)) fail('String length overflow')
    }
    cursor++
    if (length > limits.maxStringBytes)
      throw new TorrentError('limit', 'Byte string exceeds limit')
    if (length > bytes.length - cursor) fail('Truncated string')
    const value = bytes.subarray(cursor, cursor + length)
    cursor += length
    return value
  }
  const value = visit(0)
  if (cursor !== bytes.length) fail('Trailing data')
  return { value, infoRange, canonical, infoCanonical }
}
/** Canonical encoder; never use this to reconstruct an existing torrent's identity. */
export function encode(
  value: BInput,
  options: Partial<BencodeLimits> = {}
): Uint8Array {
  const limits = limitsFor(options)
  const chunks: Uint8Array[] = []
  let size = 0
  let nodes = 0
  const push = (bytes: Uint8Array) => {
    size += bytes.length
    if (size > limits.maxBytes)
      throw new TorrentError('limit', 'Encoded byte limit')
    chunks.push(bytes)
  }
  const ascii = (value: string) => push(utf8.encode(value))
  const visit = (input: BInput, depth: number): void => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth)
      throw new TorrentError('limit', 'Encoding complexity limit')
    if (typeof input === 'string') input = utf8.encode(input)
    if (typeof input === 'number') {
      if (!Number.isSafeInteger(input))
        throw new TorrentError('bencode', 'Integer is not safe')
      input = BigInt(input)
    }
    if (typeof input === 'bigint') {
      const decimal = input.toString()
      if (decimal.replace('-', '').length > limits.maxIntegerDigits)
        throw new TorrentError('limit', 'Integer digit limit')
      ascii(`i${decimal}e`)
    } else if (input instanceof Uint8Array) {
      if (input.length > limits.maxStringBytes)
        throw new TorrentError('limit', 'Byte string exceeds limit')
      ascii(`${input.length}:`)
      push(input)
    } else if (Array.isArray(input)) {
      ascii('l')
      for (const entry of input) visit(entry, depth + 1)
      ascii('e')
    } else if (input && typeof input === 'object') {
      const source =
        input instanceof BDictionary
          ? input.entries
          : input instanceof Map
            ? [...input]
            : Object.entries(input)
      const entries = source
        .map(
          ([key, value]) =>
            [typeof key === 'string' ? utf8.encode(key) : key, value] as const
        )
        .sort(([a], [b]) => compareBytes(a, b))
      ascii('d')
      let previous: Uint8Array | undefined
      for (const [key, entry] of entries) {
        if (previous && compareBytes(previous, key) === 0)
          throw new TorrentError('bencode', 'Duplicate dictionary key')
        previous = key
        visit(key, depth + 1)
        visit(entry, depth + 1)
      }
      ascii('e')
    } else throw new TorrentError('bencode', 'Unsupported value')
  }
  visit(value, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
