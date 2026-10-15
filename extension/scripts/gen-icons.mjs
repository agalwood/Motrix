import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const BRAND = [0x2d, 0x7d, 0xf6] // #2D7DF6 — connected/active
const WHITE = [0xff, 0xff, 0xff]
// Rec. 601 luma desaturation → the disconnected/offline (grey) icon tone.
const luma = ([r, g, b]) => {
  const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  return [y, y, y]
}
const GREY = luma(BRAND)

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td), 0)
  return Buffer.concat([len, td, crc])
}

function isArrow(cx, cy) {
  const stem = Math.abs(cx - 0.5) < 0.09 && cy >= 0.26 && cy <= 0.56
  const top = 0.54
  const bot = 0.76
  const head =
    cy >= top &&
    cy <= bot &&
    Math.abs(cx - 0.5) < 0.24 * ((bot - cy) / (bot - top))
  return stem || head
}

function png(size, bg, fg) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const col = isArrow((x + 0.5) / size, (y + 0.5) / size) ? fg : bg
      raw[p++] = col[0]
      raw[p++] = col[1]
      raw[p++] = col[2]
      raw[p++] = 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync('public/icons', { recursive: true })
for (const s of [16, 32, 48, 128]) {
  writeFileSync(`public/icons/icon-${s}.png`, png(s, BRAND, WHITE))
  console.log(`wrote public/icons/icon-${s}.png`)
}
// Grey variants for the toolbar action icon when Motrix is not connected
// (only the two action-icon sizes are used by BadgeController).
for (const s of [16, 32]) {
  writeFileSync(`public/icons/icon-${s}-grey.png`, png(s, GREY, WHITE))
  console.log(`wrote public/icons/icon-${s}-grey.png`)
}
