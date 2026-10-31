import { sha1 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  BDictionary,
  type BValue,
  compareBytes,
  type DecodeOptions,
  decode,
  hex,
  TorrentError,
  textDecoder,
} from './bencode.js'

export type TorrentIdentity =
  | { kind: 'v1'; sha1: string }
  | { kind: 'v2'; sha256: string }
  | { kind: 'hybrid'; sha1: string; sha256: string }

/** A borrowed compact hash table. No per-piece strings or buffers are allocated eagerly. */
export class HashTable {
  readonly length: number
  constructor(
    readonly bytes: Uint8Array,
    readonly hashBytes: 20 | 32
  ) {
    if (bytes.length % hashBytes) invalid('Invalid hash table length')
    this.length = bytes.length / hashBytes
  }
  at(index: number): Uint8Array {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length)
      throw new RangeError('Piece index out of range')
    return this.bytes.subarray(
      index * this.hashBytes,
      (index + 1) * this.hashBytes
    )
  }
  hex(index: number): string {
    return hex(this.at(index))
  }
}
export interface TorrentFile {
  /** Unmodified components relative to the torrent root (v1) or file tree (v2). */
  path: readonly Uint8Array[]
  pathUtf8?: readonly Uint8Array[]
  length: bigint
  /** v1 concatenated offset or v2 piece-aligned offset. */
  offset: bigint
  attributes: string
  padding: boolean
  symlinkPath?: readonly Uint8Array[]
  piecesRoot?: Uint8Array
  sha1?: Uint8Array
  properties: BDictionary
}
export interface TorrentMetadata {
  identity: TorrentIdentity
  name: string
  nameBytes: Uint8Array
  nameUtf8Bytes?: Uint8Array
  /** Exact views of the supplied bytes. Keep the input immutable for this object's lifetime. */
  bytes: Uint8Array
  infoBytes: Uint8Array
  infoRange: readonly [number, number]
  metainfo: BDictionary
  info: BDictionary
  canonical: boolean
  infoCanonical: boolean
  pieceLength: number
  v1?: {
    files: TorrentFile[]
    multiFile: boolean
    length: bigint
    pieces: HashTable
  }
  v2?: {
    files: TorrentFile[]
    length: bigint
    pieceLayers: ReadonlyMap<string, HashTable>
  }
  private: boolean
  announce?: string
  announceTiers: string[][]
  webSeeds: string[]
  comment?: string
  createdBy?: string
  creationDate?: bigint
}
export function invalid(message: string): never {
  throw new TorrentError('metadata', message)
}
export function dictionary(
  value: BValue | undefined,
  field: string
): BDictionary {
  if (!(value instanceof BDictionary))
    return invalid(`Expected dictionary: ${field}`)
  return value
}
function bytes(value: BValue | undefined, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) return invalid(`Expected bytes: ${field}`)
  return value
}
function integer(value: BValue | undefined, field: string): bigint {
  if (typeof value !== 'bigint') return invalid(`Expected integer: ${field}`)
  return value
}
function nonnegative(value: BValue | undefined, field: string): bigint {
  const number = integer(value, field)
  if (number < 0n) invalid(`Negative ${field}`)
  return number
}
function list(value: BValue | undefined, field: string): BValue[] {
  if (!Array.isArray(value)) return invalid(`Expected list: ${field}`)
  return value
}
function optionalText(dict: BDictionary, field: string): string | undefined {
  const value = dict.get(field)
  return value === undefined
    ? undefined
    : textDecoder.decode(bytes(value, field))
}
function paths(value: BValue | undefined, field: string): Uint8Array[] {
  const parts = list(value, field).map((part) => bytes(part, field))
  if (!parts.length || parts.some((part) => part.length === 0))
    invalid(`Empty ${field}`)
  return parts
}
function hashField(
  dict: BDictionary,
  field: string,
  length: number
): Uint8Array | undefined {
  const value = dict.get(field)
  if (value === undefined) return undefined
  const hash = bytes(value, field)
  if (hash.length !== length) invalid(`Invalid ${field}`)
  return hash
}
function file(
  properties: BDictionary,
  path: Uint8Array[],
  offset: bigint
): TorrentFile {
  const attributes = optionalText(properties, 'attr') ?? ''
  const symlink = attributes.includes('l')
  const length =
    symlink && !properties.has('length')
      ? 0n
      : nonnegative(properties.get('length'), 'file length')
  if (symlink && (length !== 0n || attributes.includes('p')))
    invalid('Invalid symlink length or attributes')
  return {
    path,
    pathUtf8: properties.has('path.utf-8')
      ? paths(properties.get('path.utf-8'), 'path.utf-8')
      : undefined,
    length,
    offset,
    attributes,
    padding: attributes.includes('p'),
    symlinkPath: symlink
      ? paths(properties.get('symlink path'), 'symlink path')
      : undefined,
    piecesRoot: hashField(properties, 'pieces root', 32),
    sha1: hashField(properties, 'sha1', 20),
    properties,
  }
}
function comparePaths(
  left: readonly Uint8Array[],
  right: readonly Uint8Array[]
): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const order = compareBytes(left[i] as Uint8Array, right[i] as Uint8Array)
    if (order) return order
  }
  return left.length - right.length
}
function parseV1(
  info: BDictionary,
  pieceLength: number
): NonNullable<TorrentMetadata['v1']> {
  const multiFile = info.has('files')
  if (multiFile === info.has('length'))
    invalid('Expected exactly one of files or length')
  const files: TorrentFile[] = []
  let length = 0n
  const entries = multiFile ? list(info.get('files'), 'files') : [info]
  if (!entries.length) invalid('Torrent contains no files')
  for (const entry of entries) {
    const properties = dictionary(entry, 'file')
    // Preserve the primary and utf-8 extension fields in properties; the primary
    // bytes define layout consistency. An application can choose a display encoding.
    const path = multiFile
      ? properties.has('path')
        ? paths(properties.get('path'), 'path')
        : []
      : []
    const parsed = file(properties, path, length)
    if (multiFile && !path.length && !parsed.padding)
      invalid('Missing file path')
    files.push(parsed)
    length += parsed.length
  }
  // Sort references, preserving the declared file order and all raw components.
  // Adjacent paths reveal both duplicates and file/directory prefix conflicts
  // without expanding paths into hex strings or rebuilding every prefix.
  const ordered = files
    .filter((entry) => !(entry.padding && !entry.path.length))
    .sort((left, right) => comparePaths(left.path, right.path))
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1] as TorrentFile
    const entry = ordered[i] as TorrentFile
    const prefix =
      previous.path.length <= entry.path.length &&
      previous.path.every(
        (part, index) =>
          compareBytes(part, entry.path[index] as Uint8Array) === 0
      )
    if (!prefix) continue
    if (previous.path.length !== entry.path.length)
      invalid('v1 file/directory conflict')
    if (
      !(previous.padding && entry.padding && previous.length === entry.length)
    )
      invalid('Conflicting v1 file path')
  }
  const pieces = new HashTable(bytes(info.get('pieces'), 'pieces'), 20)
  if (
    BigInt(pieces.length) !==
    (length + BigInt(pieceLength) - 1n) / BigInt(pieceLength)
  )
    invalid('Piece count does not match v1 length')
  return { files, multiFile, length, pieces }
}
function parentHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256.create().update(left).update(right).digest()
}
/** O(log n) working memory; pad the piece layer with zero subtrees, not zero data hashes. */
function layerRoot(layer: HashTable, pieceLength: number): Uint8Array {
  let zero: Uint8Array = new Uint8Array(32)
  for (let size = 16384; size < pieceLength; size *= 2)
    zero = parentHash(zero, zero)
  let width = 1
  while (width < layer.length) width *= 2
  const stack: (Uint8Array | undefined)[] = []
  for (let i = 0; i < width; i++) {
    let hash = i < layer.length ? layer.at(i) : zero
    let height = 0
    while (stack[height]) {
      hash = parentHash(stack[height] as Uint8Array, hash)
      stack[height++] = undefined
    }
    stack[height] = hash
  }
  return stack.find((value) => value !== undefined) as Uint8Array
}
function parseV2(
  info: BDictionary,
  metainfo: BDictionary,
  pieceLength: number
): NonNullable<TorrentMetadata['v2']> {
  const pieceSize = BigInt(pieceLength)
  if (pieceSize < 16384n || (pieceSize & (pieceSize - 1n)) !== 0n)
    invalid('v2 piece length must be a power of two >= 16 KiB')
  const files: TorrentFile[] = []
  let offset = 0n
  let length = 0n
  const visit = (tree: BDictionary, path: Uint8Array[]) => {
    const properties = tree.get('')
    if (properties !== undefined) {
      if (!path.length || tree.entries.length !== 1)
        invalid('File tree has a file/directory conflict')
      const entry = file(
        dictionary(properties, 'file properties'),
        path,
        offset
      )
      if (entry.padding) invalid('v2 file tree must not contain padding files')
      if (
        entry.length > 0n
          ? !entry.piecesRoot || entry.piecesRoot.every((byte) => byte === 0)
          : entry.piecesRoot !== undefined
      )
        invalid('Invalid pieces root presence')
      files.push(entry)
      length += entry.length
      const size = BigInt(pieceLength)
      offset += ((entry.length + size - 1n) / size) * size
      return
    }
    if (!tree.entries.length) invalid('Empty file tree directory')
    for (const [name, child] of tree.entries)
      visit(dictionary(child, 'file tree'), [...path, name])
  }
  visit(dictionary(info.get('file tree'), 'file tree'), [])
  const layers = metainfo.has('piece layers')
    ? dictionary(metainfo.get('piece layers'), 'piece layers')
    : new BDictionary([])
  const pieceLayers = new Map<string, HashTable>()
  for (const [root, value] of layers.entries) {
    if (root.length !== 32) invalid('Invalid piece layer key')
    pieceLayers.set(hex(root), new HashTable(bytes(value, 'piece layer'), 32))
  }
  const used = new Set<string>()
  for (const entry of files) {
    if (entry.length <= BigInt(pieceLength)) continue
    const root = entry.piecesRoot as Uint8Array
    const key = hex(root)
    const layer = pieceLayers.get(key)
    const expected =
      (entry.length + BigInt(pieceLength) - 1n) / BigInt(pieceLength)
    if (!layer || BigInt(layer.length) !== expected)
      invalid('Missing or incorrect piece layer')
    if (!used.has(key) && compareBytes(layerRoot(layer, pieceLength), root))
      invalid('Piece layer does not match pieces root')
    used.add(key)
  }
  if (used.size !== pieceLayers.size) invalid('Unreferenced piece layer')
  return { files, length, pieceLayers }
}
function validateHybrid(
  v1: NonNullable<TorrentMetadata['v1']>,
  v2: NonNullable<TorrentMetadata['v2']>,
  name: Uint8Array,
  pieceLength: number
) {
  // Hidden/executable hints and unknown BEP 47 flags do not change content.
  // Padding and symlink semantics are still validated independently.
  const content = v1.files.filter((entry) => !entry.padding)
  if (content.length !== v2.files.length) invalid('Hybrid file count mismatch')
  for (let i = 0; i < content.length; i++) {
    const a = content[i] as TorrentFile
    const b = v2.files[i] as TorrentFile
    const path = v1.multiFile ? a.path : [name]
    if (
      a.length !== b.length ||
      (a.length > 0n && a.offset !== b.offset) ||
      path.length !== b.path.length ||
      path.some((part, index) =>
        compareBytes(part, b.path[index] as Uint8Array)
      ) ||
      Boolean(a.symlinkPath) !== Boolean(b.symlinkPath)
    )
      invalid('Hybrid file layout mismatch')
    const al = a.symlinkPath ?? []
    const bl = b.symlinkPath ?? []
    if (
      al.length !== bl.length ||
      al.some((part, index) => compareBytes(part, bl[index] as Uint8Array))
    )
      invalid('Hybrid symlink mismatch')
  }
  for (const [index, entry] of v1.files.entries()) {
    if (!entry.padding) continue
    const previous = v1.files[index - 1]
    const remainder = entry.offset % BigInt(pieceLength)
    if (
      !previous ||
      previous.padding ||
      remainder === 0n ||
      entry.length !== BigInt(pieceLength) - remainder
    )
      invalid('Invalid hybrid padding')
  }
}
export function parseTorrent(
  bytesInput: Uint8Array,
  options: DecodeOptions = {}
): TorrentMetadata {
  const decoded = decode(bytesInput, options)
  const metainfo = dictionary(decoded.value, 'metainfo')
  const info = dictionary(metainfo.get('info'), 'info')
  const version = info.get('meta version')
  if (version !== undefined && version !== 2n)
    throw new TorrentError('version', 'Unsupported torrent meta version')
  if (version === 2n && !decoded.canonical)
    invalid('v2 requires canonical bencode')
  const nameBytes = bytes(info.get('name'), 'name')
  if (!nameBytes.length) invalid('Empty torrent name')
  const size = nonnegative(info.get('piece length'), 'piece length')
  if (!size || size > BigInt(Number.MAX_SAFE_INTEGER))
    invalid('Invalid piece length')
  const pieceLength = Number(size)
  const hasV1 = info.has('pieces')
  if (!hasV1 && version !== 2n) invalid('Missing v1 pieces')
  if (!hasV1 && (info.has('files') || info.has('length')))
    invalid('Incomplete hybrid metadata')
  const v1 = hasV1 ? parseV1(info, pieceLength) : undefined
  const v2 = version === 2n ? parseV2(info, metainfo, pieceLength) : undefined
  if (v1 && v2) validateHybrid(v1, v2, nameBytes, pieceLength)
  const infoRange = decoded.infoRange as readonly [number, number]
  const infoBytes = bytesInput.subarray(...infoRange)
  const identity: TorrentIdentity =
    v1 && v2
      ? {
          kind: 'hybrid',
          sha1: hex(sha1(infoBytes)),
          sha256: hex(sha256(infoBytes)),
        }
      : v2
        ? { kind: 'v2', sha256: hex(sha256(infoBytes)) }
        : { kind: 'v1', sha1: hex(sha1(infoBytes)) }
  const privacy = info.get('private')
  if (privacy !== undefined && privacy !== 0n && privacy !== 1n)
    invalid('Invalid private flag')
  const announce = optionalText(metainfo, 'announce')
  const announceTiers = metainfo.has('announce-list')
    ? list(metainfo.get('announce-list'), 'announce-list').map((tier) =>
        list(tier, 'announce tier').map((url) =>
          textDecoder.decode(bytes(url, 'tracker'))
        )
      )
    : announce
      ? [[announce]]
      : []
  const urls = metainfo.get('url-list')
  const webSeeds =
    urls === undefined || (urls instanceof Uint8Array && urls.length === 0)
      ? []
      : (Array.isArray(urls) ? urls : [urls]).map((value) =>
          textDecoder.decode(bytes(value, 'url-list'))
        )
  return {
    identity,
    name: textDecoder.decode(nameBytes),
    nameBytes,
    nameUtf8Bytes: info.has('name.utf-8')
      ? bytes(info.get('name.utf-8'), 'name.utf-8')
      : undefined,
    bytes: bytesInput,
    infoBytes,
    infoRange,
    metainfo,
    info,
    canonical: decoded.canonical,
    infoCanonical: decoded.infoCanonical === true,
    pieceLength,
    v1,
    v2,
    private: privacy === 1n,
    announce,
    announceTiers,
    webSeeds,
    comment: optionalText(metainfo, 'comment'),
    createdBy: optionalText(metainfo, 'created by'),
    creationDate: metainfo.has('creation date')
      ? integer(metainfo.get('creation date'), 'creation date')
      : undefined,
  }
}
