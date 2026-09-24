// Converts the NSIS assisted-installer design sources (build/installer-*.png)
// into 24-bit BMP files using electron-builder's default resource names.
// Both local and isolated release builds discover the bitmaps when present.
//
//   pnpm run build:installer-images
//
// When present, the PNG design sources must be 8-bit RGB or RGBA,
// non-interlaced, and exported at the exact Modern UI 2 sizes listed below.
// NSIS only accepts uncompressed 24-bit bitmaps, so the BMPs are derived and
// committed. Missing optional PNG sources are skipped. The installer is not
// DPI-aware (Windows scales the dialog), so keep native sizes rather than
// shipping 2x variants.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const BMP_HEADER_SIZE = 14 + 40

/**
 * Modern UI 2 bitmap slots and the native sizes NSIS expects for them.
 * header: right of the page title on every page after Welcome
 *         (electron-builder sets MUI_HEADERIMAGE_RIGHT when it is present).
 * sidebar: Welcome and Finish pages; the uninstaller reuses it by default.
 */
export const INSTALLER_IMAGES = [
  {
    name: 'header',
    png: 'build/installer-header.png',
    output: 'build/installerHeader.bmp',
    width: 150,
    height: 57,
  },
  {
    name: 'sidebar',
    png: 'build/installer-sidebar.png',
    output: 'build/installerSidebar.bmp',
    width: 164,
    height: 314,
  },
]

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG into top-down RGB rows. */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file')
  }
  let ihdr
  const idat = []
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') ihdr = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (!ihdr) throw new Error('PNG is missing its IHDR chunk')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  const interlace = ihdr[12]
  if (
    bitDepth !== 8 ||
    interlace !== 0 ||
    (colorType !== 2 && colorType !== 6)
  ) {
    throw new Error(
      `Unsupported PNG: depth=${bitDepth} colorType=${colorType} interlace=${interlace}`
    )
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const rgb = Buffer.alloc(width * height * 3)
  let previous = Buffer.alloc(stride)
  let current = Buffer.alloc(stride)
  let input = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[input++]
    for (let i = 0; i < stride; i++) {
      const x = raw[input + i]
      const a = i >= channels ? current[i - channels] : 0
      const b = previous[i]
      const c = i >= channels ? previous[i - channels] : 0
      let value
      switch (filter) {
        case 0:
          value = x
          break
        case 1:
          value = x + a
          break
        case 2:
          value = x + b
          break
        case 3:
          value = x + ((a + b) >> 1)
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw new Error(`Unsupported PNG filter ${filter} on row ${y}`)
      }
      current[i] = value & 255
    }
    input += stride
    for (let px = 0; px < width; px++) {
      rgb.set(
        current.subarray(px * channels, px * channels + 3),
        (y * width + px) * 3
      )
    }
    ;[previous, current] = [current, previous]
  }
  return { width, height, rgb }
}

/** Encodes top-down RGB rows as an uncompressed, bottom-up, 24-bit Windows BMP. */
export function encodeBmp24(width, height, rgb) {
  if (rgb.length !== width * height * 3) {
    throw new Error(
      `Expected ${width * height * 3} RGB bytes for ${width}x${height}, received ${rgb.length}`
    )
  }
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixelBytes = rowSize * height
  const bmp = Buffer.alloc(BMP_HEADER_SIZE + pixelBytes)
  bmp.write('BM', 0, 'latin1')
  bmp.writeUInt32LE(bmp.length, 2)
  bmp.writeUInt32LE(BMP_HEADER_SIZE, 10)
  bmp.writeUInt32LE(40, 14) // BITMAPINFOHEADER
  bmp.writeInt32LE(width, 18)
  bmp.writeInt32LE(height, 22) // positive height = bottom-up rows
  bmp.writeUInt16LE(1, 26) // planes
  bmp.writeUInt16LE(24, 28) // bits per pixel
  bmp.writeUInt32LE(0, 30) // BI_RGB, no compression
  bmp.writeUInt32LE(pixelBytes, 34)
  bmp.writeInt32LE(2835, 38) // 72 dpi
  bmp.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y++) {
    const rowOffset = BMP_HEADER_SIZE + (height - 1 - y) * rowSize
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 3
      const target = rowOffset + x * 3
      bmp[target] = rgb[source + 2]
      bmp[target + 1] = rgb[source + 1]
      bmp[target + 2] = rgb[source]
    }
  }
  return bmp
}

/** Reads the fields of a BMP header that NSIS compatibility depends on. */
export function readBmpHeader(buffer) {
  if (
    buffer.length < BMP_HEADER_SIZE ||
    buffer.toString('latin1', 0, 2) !== 'BM'
  ) {
    throw new Error('Not a BMP file')
  }
  return {
    fileSize: buffer.readUInt32LE(2),
    pixelOffset: buffer.readUInt32LE(10),
    width: buffer.readInt32LE(18),
    height: Math.abs(buffer.readInt32LE(22)),
    bitsPerPixel: buffer.readUInt16LE(28),
    compression: buffer.readUInt32LE(30),
  }
}

/** Converts available build/installer-*.png sources into NSIS bitmaps. */
export async function convertInstallerPngs({
  rootDir = REPOSITORY_ROOT,
  images = INSTALLER_IMAGES,
  log = console.log,
} = {}) {
  const written = []
  for (const image of images) {
    let png
    try {
      png = await readFile(path.join(rootDir, image.png))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      log(`${image.png} not found; skipping`)
      continue
    }
    const { width, height, rgb } = decodePng(png)
    if (width !== image.width || height !== image.height) {
      throw new Error(
        `${image.name} is ${width}x${height}, expected ${image.width}x${image.height}`
      )
    }
    const bmp = encodeBmp24(width, height, rgb)
    const target = path.join(rootDir, image.output)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bmp)
    log(
      `${image.png} -> ${image.output}  ${width}x${height}  24-bit BMP  ${(bmp.length / 1024).toFixed(0)} KiB`
    )
    written.push(target)
  }
  return written
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  await convertInstallerPngs()
}
