// Minimal bencode encoder (BEP-3 wire format). A decoder is intentionally
// not provided — parse-torrent already owns that side of the boundary.
// Deterministic output: dict keys are sorted by UTF-8 byte order, which is
// also what the info-dict hashing requires.

export type BencodeValue =
  | number
  | string
  | Uint8Array
  | BencodeValue[]
  | { [key: string]: BencodeValue | undefined | null }

export function bencodeEncode(value: BencodeValue): Uint8Array {
  const chunks: Uint8Array[] = []
  encodeInto(value, chunks)
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function encodeInto(value: BencodeValue, chunks: Uint8Array[]): void {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TypeError(`bencode: non-integer number ${value}`)
    }
    chunks.push(text(`i${value}e`))
    return
  }
  if (typeof value === 'string') {
    const bytes = text(value)
    chunks.push(text(`${bytes.length}:`), bytes)
    return
  }
  if (isByteString(value)) {
    chunks.push(text(`${value.length}:`), value)
    return
  }
  if (Array.isArray(value)) {
    chunks.push(text('l'))
    for (const item of value) encodeInto(item, chunks)
    chunks.push(text('e'))
    return
  }
  // Plain object → dict with keys sorted by byte order. null/undefined
  // values are skipped so callers can build dicts conditionally.
  const entries: Array<{ key: Uint8Array; value: BencodeValue }> =
    Object.entries(value)
      .filter(
        (entry): entry is [string, BencodeValue] =>
          entry[1] !== undefined && entry[1] !== null
      )
      .map(([key, v]) => ({ key: text(key), value: v }))
  entries.sort((a, b) => compareBytes(a.key, b.key))
  chunks.push(text('d'))
  for (const entry of entries) {
    chunks.push(text(`${entry.key.length}:`), entry.key)
    encodeInto(entry.value, chunks)
  }
  chunks.push(text('e'))
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

// Realm-independent byte-string detection: `instanceof Uint8Array` fails for
// Buffers produced in a different V8 realm (some test/embedded contexts),
// while the toString tag stays reliable. Buffers carry the Uint8Array tag.
function isByteString(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === '[object Uint8Array]'
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}
