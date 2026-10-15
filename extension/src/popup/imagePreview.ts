const MAX_CONCURRENT_PREVIEWS = 3
export const MAX_IMAGE_PREVIEW_BYTES = 2 * 1024 * 1024
export const MAX_IMAGE_PREVIEW_CHUNK_BYTES = 256 * 1024
const MAX_IMAGE_PREVIEW_CHUNKS = 4096
export const MAX_IMAGE_PREVIEW_EDGE = 8192
export const MAX_IMAGE_PREVIEW_PIXELS = 24 * 1024 * 1024
const MAX_IMAGE_HEADER_SCAN_BYTES = 512 * 1024
const DEFAULT_THUMBNAIL_SIZE = 72
const MAX_THUMBNAIL_EDGE = 256

const RASTER_IMAGE_MIME_TYPES = new Set([
  'image/apng',
  'image/avif',
  'image/avif-sequence',
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heic-sequence',
  'image/heif',
  'image/heif-sequence',
  'image/jpeg',
  'image/jpg',
  'image/jxl',
  'image/pjpeg',
  'image/png',
  'image/tiff',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
  'image/x-png',
])

type OwnedBytes = Uint8Array<ArrayBuffer>

type ImageDimensions = {
  width: number
  height: number
}

type QueueEntry = {
  signal: AbortSignal | undefined
  resolve: () => void
  reject: (reason: unknown) => void
  onAbort: () => void
}

const previewQueue: QueueEntry[] = []
let activePreviewLoads = 0

function previewAbortError(): DOMException {
  return new DOMException('Image preview load was aborted', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw previewAbortError()
}

function ipv4Octets(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => Number(part))
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null
  }
  return octets as [number, number, number, number]
}

function isPrivateIpv4([first, second]: [
  number,
  number,
  number,
  number,
]): boolean {
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}

function ipv6Hextets(hostname: string): number[] | null {
  const address = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const halves = address.split('::')
  if (halves.length > 2) return null
  const parseHalf = (half: string): number[] | null => {
    if (!half) return []
    const parts = half.split(':')
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
    return parts.map((part) => Number.parseInt(part, 16))
  }
  const left = parseHalf(halves[0] ?? '')
  const right = parseHalf(halves[1] ?? '')
  if (!left || !right) return null
  if (halves.length === 1) return left.length === 8 ? left : null
  const omitted = 8 - left.length - right.length
  if (omitted < 1) return null
  return [...left, ...Array.from({ length: omitted }, () => 0), ...right]
}

function isPrivateIpv6(hextets: number[]): boolean {
  if (hextets.length !== 8) return true
  const first = hextets[0] ?? 0
  const loopback =
    hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1
  const unspecified = hextets.every((part) => part === 0)
  const uniqueLocal = (first & 0xfe00) === 0xfc00
  const linkLocal = (first & 0xffc0) === 0xfe80
  const ipv4Mapped =
    hextets.slice(0, 5).every((part) => part === 0) &&
    (hextets[5] === 0 || hextets[5] === 0xffff)
  if (ipv4Mapped) {
    const high = hextets[6] ?? 0
    const low = hextets[7] ?? 0
    return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff])
  }
  return loopback || unspecified || uniqueLocal || linkLocal
}

function assertPublicPreviewHost(parsedUrl: URL): void {
  const hostname = parsedUrl.hostname.toLowerCase().replace(/\.$/, '')
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw new Error('Image preview host must be public')
  }
  const ipv4 = ipv4Octets(hostname)
  if (ipv4) {
    if (isPrivateIpv4(ipv4)) {
      throw new Error('Image preview host must be public')
    }
    return
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const ipv6 = ipv6Hextets(hostname)
    if (!ipv6 || isPrivateIpv6(ipv6)) {
      throw new Error('Image preview host must be public')
    }
    return
  }
  if (!hostname.includes('.')) {
    throw new Error('Image preview host must be a public domain')
  }
}

function pumpPreviewQueue(): void {
  while (
    activePreviewLoads < MAX_CONCURRENT_PREVIEWS &&
    previewQueue.length > 0
  ) {
    const entry = previewQueue.shift()
    if (!entry) return
    entry.signal?.removeEventListener('abort', entry.onAbort)
    if (entry.signal?.aborted) {
      entry.reject(previewAbortError())
      continue
    }
    activePreviewLoads += 1
    entry.resolve()
  }
}

function acquirePreviewSlot(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const entry: QueueEntry = {
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = previewQueue.indexOf(entry)
        if (index < 0) return
        previewQueue.splice(index, 1)
        signal?.removeEventListener('abort', entry.onAbort)
        reject(previewAbortError())
      },
    }
    signal?.addEventListener('abort', entry.onAbort, { once: true })
    previewQueue.push(entry)
    pumpPreviewQueue()
  })
}

function releasePreviewSlot(): void {
  activePreviewLoads = Math.max(0, activePreviewLoads - 1)
  pumpPreviewQueue()
}

function rasterMimeType(response: Response): string {
  const mimeType =
    response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase() ?? ''
  if (mimeType === 'image/svg+xml' || !RASTER_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error('Image preview response is not a supported raster image')
  }
  return mimeType
}

function declaredResponseBytes(response: Response): number | null {
  const rawLength = response.headers.get('content-length')
  if (!rawLength) return null
  const length = Number(rawLength)
  return Number.isSafeInteger(length) && length >= 0 ? length : null
}

function looksLikeSvg(chunks: OwnedBytes[]): boolean {
  const prefix = new Uint8Array(
    Math.min(
      2048,
      chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    )
  )
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= prefix.byteLength) break
    const slice = chunk.subarray(0, prefix.byteLength - offset)
    prefix.set(slice, offset)
    offset += slice.byteLength
  }
  const text = new TextDecoder().decode(prefix)
  return /^\uFEFF?\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(
    text
  )
}

function uint16(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean
): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) return 0
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getUint16(offset, littleEndian)
}

function uint32(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean
): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) return 0
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getUint32(offset, littleEndian)
}

function int32(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean
): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) return 0
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getInt32(offset, littleEndian)
}

function matchesBytes(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[]
): boolean {
  return expected.every((value, index) => bytes[offset + index] === value)
}

function pngDimensions(bytes: Uint8Array, offset = 0): ImageDimensions | null {
  if (
    offset + 24 > bytes.byteLength ||
    !matchesBytes(bytes, offset, [137, 80, 78, 71, 13, 10, 26, 10]) ||
    !matchesBytes(bytes, offset + 12, [73, 72, 68, 82])
  ) {
    return null
  }
  return {
    width: uint32(bytes, offset + 16, false),
    height: uint32(bytes, offset + 20, false),
  }
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.byteLength < 10 ||
    (!matchesBytes(bytes, 0, [71, 73, 70, 56, 55, 97]) &&
      !matchesBytes(bytes, 0, [71, 73, 70, 56, 57, 97]))
  ) {
    return null
  }
  return {
    width: uint16(bytes, 6, true),
    height: uint16(bytes, 8, true),
  }
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null
  }
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ])
  let offset = 2
  while (offset + 3 < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.byteLength) return null
    const marker = bytes[offset] ?? 0
    offset += 1
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue
    }
    if (offset + 2 > bytes.byteLength) return null
    const segmentLength = uint16(bytes, offset, false)
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      return null
    }
    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      return {
        width: uint16(bytes, offset + 5, false),
        height: uint16(bytes, offset + 3, false),
      }
    }
    if (marker === 0xda) return null
    offset += segmentLength
  }
  return null
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.byteLength < 30 ||
    !matchesBytes(bytes, 0, [82, 73, 70, 70]) ||
    !matchesBytes(bytes, 8, [87, 69, 66, 80])
  ) {
    return null
  }
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const chunkSize = uint32(bytes, offset + 4, true)
    const dataOffset = offset + 8
    if (chunkSize > bytes.byteLength - dataOffset) return null
    if (matchesBytes(bytes, offset, [86, 80, 56, 88]) && chunkSize >= 10) {
      const width =
        1 +
        ((bytes[dataOffset + 4] ?? 0) |
          ((bytes[dataOffset + 5] ?? 0) << 8) |
          ((bytes[dataOffset + 6] ?? 0) << 16))
      const height =
        1 +
        ((bytes[dataOffset + 7] ?? 0) |
          ((bytes[dataOffset + 8] ?? 0) << 8) |
          ((bytes[dataOffset + 9] ?? 0) << 16))
      return { width, height }
    }
    if (
      matchesBytes(bytes, offset, [86, 80, 56, 76]) &&
      chunkSize >= 5 &&
      bytes[dataOffset] === 0x2f
    ) {
      const packed = uint32(bytes, dataOffset + 1, true)
      return {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1,
      }
    }
    if (
      matchesBytes(bytes, offset, [86, 80, 56, 32]) &&
      chunkSize >= 10 &&
      matchesBytes(bytes, dataOffset + 3, [0x9d, 0x01, 0x2a])
    ) {
      return {
        width: uint16(bytes, dataOffset + 6, true) & 0x3fff,
        height: uint16(bytes, dataOffset + 8, true) & 0x3fff,
      }
    }
    offset = dataOffset + chunkSize + (chunkSize % 2)
  }
  return null
}

function bmpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    return null
  }
  const dibSize = uint32(bytes, 14, true)
  if (dibSize === 12) {
    return {
      width: uint16(bytes, 18, true),
      height: uint16(bytes, 20, true),
    }
  }
  if (dibSize < 40) return null
  return {
    width: Math.abs(int32(bytes, 18, true)),
    height: Math.abs(int32(bytes, 22, true)),
  }
}

function icoDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.byteLength < 22 ||
    bytes[0] !== 0 ||
    bytes[1] !== 0 ||
    bytes[2] !== 1 ||
    bytes[3] !== 0
  ) {
    return null
  }
  const count = Math.min(uint16(bytes, 4, true), 256)
  if (count === 0 || 6 + count * 16 > bytes.byteLength) return null
  let width = 0
  let height = 0
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16
    let entryWidth = bytes[entryOffset] || 256
    let entryHeight = bytes[entryOffset + 1] || 256
    const payloadBytes = uint32(bytes, entryOffset + 8, true)
    const payloadOffset = uint32(bytes, entryOffset + 12, true)
    if (
      payloadBytes === 0 ||
      payloadOffset > bytes.byteLength ||
      payloadBytes > bytes.byteLength - payloadOffset
    ) {
      return null
    }
    const embeddedPng =
      payloadBytes >= 24 ? pngDimensions(bytes, payloadOffset) : null
    if (embeddedPng) {
      entryWidth = embeddedPng.width
      entryHeight = embeddedPng.height
    } else {
      const dibSize = uint32(bytes, payloadOffset, true)
      if (dibSize === 12 && payloadBytes >= 12) {
        entryWidth = uint16(bytes, payloadOffset + 4, true)
        entryHeight = Math.ceil(uint16(bytes, payloadOffset + 6, true) / 2)
      } else if (dibSize >= 40 && payloadBytes >= 40) {
        entryWidth = Math.abs(int32(bytes, payloadOffset + 4, true))
        entryHeight = Math.ceil(
          Math.abs(int32(bytes, payloadOffset + 8, true)) / 2
        )
      } else {
        return null
      }
    }
    width = Math.max(width, entryWidth)
    height = Math.max(height, entryHeight)
  }
  return { width, height }
}

function tiffDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 16) return null
  const littleEndian = bytes[0] === 0x49 && bytes[1] === 0x49
  const bigEndian = bytes[0] === 0x4d && bytes[1] === 0x4d
  if ((!littleEndian && !bigEndian) || uint16(bytes, 2, littleEndian) !== 42) {
    return null
  }
  const ifdOffset = uint32(bytes, 4, littleEndian)
  if (ifdOffset + 2 > bytes.byteLength) return null
  const entryCount = Math.min(uint16(bytes, ifdOffset, littleEndian), 4096)
  if (ifdOffset + 2 + entryCount * 12 > bytes.byteLength) return null
  let width = 0
  let height = 0
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12
    const tag = uint16(bytes, entryOffset, littleEndian)
    if (tag !== 256 && tag !== 257) continue
    const type = uint16(bytes, entryOffset + 2, littleEndian)
    const count = uint32(bytes, entryOffset + 4, littleEndian)
    if (count !== 1 || (type !== 3 && type !== 4)) continue
    const value =
      type === 3
        ? uint16(bytes, entryOffset + 8, littleEndian)
        : uint32(bytes, entryOffset + 8, littleEndian)
    if (tag === 256) width = value
    if (tag === 257) height = value
  }
  return width > 0 && height > 0 ? { width, height } : null
}

const ISO_BMFF_RASTER_BRANDS = new Set([
  'avif',
  'avis',
  'heic',
  'heix',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
])

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) return ''
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function isoBmffDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 20 || ascii(bytes, 4, 4) !== 'ftyp') return null
  const ftypSize = uint32(bytes, 0, false)
  if (ftypSize < 16 || ftypSize > bytes.byteLength) return null
  let rasterBrand = ISO_BMFF_RASTER_BRANDS.has(ascii(bytes, 8, 4))
  for (let offset = 16; !rasterBrand && offset + 4 <= ftypSize; offset += 4) {
    rasterBrand = ISO_BMFF_RASTER_BRANDS.has(ascii(bytes, offset, 4))
  }
  if (!rasterBrand) return null
  let width = 0
  let height = 0
  for (let offset = 4; offset + 16 <= bytes.byteLength; offset += 1) {
    if (!matchesBytes(bytes, offset, [105, 115, 112, 101])) continue
    const boxSize = uint32(bytes, offset - 4, false)
    if (boxSize < 20 || offset - 4 + boxSize > bytes.byteLength) continue
    width = Math.max(width, uint32(bytes, offset + 8, false))
    height = Math.max(height, uint32(bytes, offset + 12, false))
  }
  return width > 0 && height > 0 ? { width, height } : null
}

function imageDimensions(bytes: Uint8Array): ImageDimensions | null {
  const header = bytes.subarray(0, MAX_IMAGE_HEADER_SCAN_BYTES)
  return (
    pngDimensions(header) ??
    gifDimensions(header) ??
    jpegDimensions(header) ??
    webpDimensions(header) ??
    bmpDimensions(header) ??
    icoDimensions(bytes) ??
    tiffDimensions(header) ??
    isoBmffDimensions(header)
  )
}

function assertSafeDimensions({ width, height }: ImageDimensions): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error('Image preview has invalid dimensions')
  }
  if (
    width > MAX_IMAGE_PREVIEW_EDGE ||
    height > MAX_IMAGE_PREVIEW_EDGE ||
    width * height > MAX_IMAGE_PREVIEW_PIXELS
  ) {
    throw new Error('Image preview dimensions exceed the safety limit')
  }
}

function combineChunks(chunks: OwnedBytes[]): OwnedBytes {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const combined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}

function thumbnailEdge(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_THUMBNAIL_SIZE
  return Math.min(MAX_THUMBNAIL_EDGE, Math.max(1, Math.round(value as number)))
}

function createPreviewObjectUrl(blob: Blob, signal?: AbortSignal): string {
  throwIfAborted(signal)
  const objectUrl = URL.createObjectURL(blob)
  if (signal?.aborted) {
    URL.revokeObjectURL(objectUrl)
    throw previewAbortError()
  }
  return objectUrl
}

async function renderThumbnail(
  bitmap: ImageBitmap,
  width: number,
  height: number
): Promise<Blob | null> {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) return null
  const sourceRatio = bitmap.width / bitmap.height
  const targetRatio = width / height
  let sourceX = 0
  let sourceY = 0
  let sourceWidth = bitmap.width
  let sourceHeight = bitmap.height
  if (sourceRatio > targetRatio) {
    sourceWidth = bitmap.height * targetRatio
    sourceX = (bitmap.width - sourceWidth) / 2
  } else if (sourceRatio < targetRatio) {
    sourceHeight = bitmap.width / targetRatio
    sourceY = (bitmap.height - sourceHeight) / 2
  }
  context.drawImage(
    bitmap,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height
  )
  try {
    const webp = await canvas.convertToBlob({
      type: 'image/webp',
      quality: 0.78,
    })
    if (webp.size > 0) return webp
  } catch {
    // PNG remains available on engines without WebP canvas encoding.
  }
  try {
    const png = await canvas.convertToBlob({ type: 'image/png' })
    return png.size > 0 ? png : null
  } catch {
    return null
  }
}

async function thumbnailOrOriginal(
  blob: Blob,
  dimensions: ImageDimensions | null,
  options: ImagePreviewOptions
): Promise<string> {
  if (!dimensions) {
    throw new Error('Image preview dimensions could not be verified safely')
  }
  assertSafeDimensions(dimensions)
  if (
    typeof globalThis.createImageBitmap !== 'function' ||
    typeof globalThis.OffscreenCanvas !== 'function'
  ) {
    return createPreviewObjectUrl(blob, options.signal)
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await globalThis.createImageBitmap(blob)
  } catch {
    throwIfAborted(options.signal)
    return createPreviewObjectUrl(blob, options.signal)
  }
  try {
    throwIfAborted(options.signal)
    assertSafeDimensions({ width: bitmap.width, height: bitmap.height })
    let thumbnail: Blob | null = null
    try {
      thumbnail = await renderThumbnail(
        bitmap,
        thumbnailEdge(options.width),
        thumbnailEdge(options.height)
      )
    } catch {
      // A decoder/canvas capability failure should not hide an otherwise safe image.
    }
    throwIfAborted(options.signal)
    return createPreviewObjectUrl(thumbnail ?? blob, options.signal)
  } finally {
    bitmap.close()
  }
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  throwIfAborted(signal)
  if (!signal) return reader.read()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (): boolean => {
      if (settled) return false
      settled = true
      signal.removeEventListener('abort', onAbort)
      return true
    }
    const onAbort = (): void => {
      if (!finish()) return
      void reader.cancel(previewAbortError()).catch(() => undefined)
      reject(previewAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void reader.read().then(
      (result) => {
        if (finish()) resolve(result)
      },
      (error: unknown) => {
        if (finish()) reject(error)
      }
    )
  })
}

async function readBoundedImage(
  response: Response,
  signal?: AbortSignal
): Promise<OwnedBytes[]> {
  const declaredBytes = declaredResponseBytes(response)
  if (declaredBytes !== null && declaredBytes > MAX_IMAGE_PREVIEW_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Image preview exceeds the size limit')
  }
  if (!response.body) throw new Error('Image preview response has no body')

  const reader = response.body.getReader()
  const chunks: OwnedBytes[] = []
  let totalBytes = 0
  let chunkCount = 0
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal)
      if (done) break
      if (!value || value.byteLength === 0) continue
      chunkCount += 1
      if (chunkCount > MAX_IMAGE_PREVIEW_CHUNKS) {
        throw new Error('Image preview response has too many chunks')
      }
      if (value.byteLength > MAX_IMAGE_PREVIEW_CHUNK_BYTES) {
        throw new Error('Image preview response chunk exceeds the size limit')
      }
      totalBytes += value.byteLength
      if (totalBytes > MAX_IMAGE_PREVIEW_BYTES) {
        throw new Error('Image preview exceeds the size limit')
      }
      chunks.push(new Uint8Array(value))
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  if (totalBytes === 0) throw new Error('Image preview response is empty')
  return chunks
}

export interface ImagePreviewOptions {
  signal?: AbortSignal
  width?: number
  height?: number
}

export async function loadImagePreview(
  url: string,
  options: ImagePreviewOptions = {}
): Promise<string> {
  const parsedUrl = new URL(url)
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Image preview URL must use HTTP or HTTPS')
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Image preview URL must not contain credentials')
  }
  assertPublicPreviewHost(parsedUrl)
  // Page-side Canvas sampling covers already-rendered HTTP/private images
  // without another request. The extension fetch fallback stays HTTPS-only so
  // DNS rebinding cannot silently turn a public-looking URL into a plaintext
  // request to a local service.
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Image preview URL must use HTTPS')
  }
  if (/\.svgz?$/i.test(parsedUrl.pathname)) {
    throw new Error('SVG image previews are not allowed')
  }

  await acquirePreviewSlot(options.signal)
  try {
    throwIfAborted(options.signal)
    const requestInit: RequestInit = {
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    }
    if (options.signal) requestInit.signal = options.signal
    const response = await fetch(parsedUrl.href, requestInit)
    throwIfAborted(options.signal)
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`Image preview request failed (${response.status})`)
    }
    let mimeType: string
    try {
      mimeType = rasterMimeType(response)
    } catch (error) {
      await response.body?.cancel().catch(() => undefined)
      throw error
    }
    const chunks = await readBoundedImage(response, options.signal)
    if (looksLikeSvg(chunks)) {
      throw new Error('SVG image previews are not allowed')
    }
    throwIfAborted(options.signal)
    const bytes = combineChunks(chunks)
    const blob = new Blob([bytes], { type: mimeType })
    return await thumbnailOrOriginal(blob, imageDimensions(bytes), options)
  } finally {
    releasePreviewSlot()
  }
}
