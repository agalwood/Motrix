#!/usr/bin/env node

/**
 * Tray Icon Visual Test Script
 *
 * Renders all tray icon states and speedometer variations as PNG files
 * for visual inspection. No Electron required — uses @resvg/resvg-wasm.
 *
 * Usage:
 *   node scripts/test-tray-render.mjs
 *
 * Output:
 *   scripts/out/
 *   ├── 01-icon-original.png          — Original SVG (colored)
 *   ├── 02-icon-template.png          — Template image (all black, for macOS)
 *   ├── 03-icon-template-2x.png       — Template @2x (actual tray size)
 *   ├── 04-speed-idle.png             — Speedometer: 0 B/s / 0 B/s
 *   ├── 05-speed-slow.png             — Speedometer: 50 KB/s / 200 KB/s
 *   ├── 06-speed-medium.png           — Speedometer: 1.2 MB/s / 5.8 MB/s
 *   ├── 07-speed-fast.png             — Speedometer: 15.3 MB/s / 98.7 MB/s
 *   ├── 08-speed-extreme.png          — Speedometer: 500 MB/s / 1.2 GB/s
 *   ├── 09-speed-upload-only.png      — Speedometer: 3.5 MB/s / 0 B/s
 *   ├── 10-speed-download-only.png    — Speedometer: 0 B/s / 12.4 MB/s
 *   └── 11-speed-bytes.png            — Speedometer: 128 B/s / 512 B/s
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

// ─── Load resvg-wasm ────────────────────────────────────────

const { initWasm, Resvg } = await import('@resvg/resvg-wasm')
const wasmBinary = readFileSync(path.join(projectRoot, 'extra/tray/resvg.wasm'))
await initWasm(wasmBinary)

// ─── Helpers (copied from source to avoid Electron deps) ────

const UNITS = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s']

function formatSpeed(bytes) {
  if (bytes === 0) return '0 B/s'
  let unitIndex = 0
  let value = bytes
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024
    unitIndex++
  }
  if (unitIndex === 0) return `${Math.round(value)} ${UNITS[unitIndex]}`
  return `${value.toFixed(0)} ${UNITS[unitIndex]}`
}

function buildSpeedometerSvg(iconSvg, uploadSpeed, downloadSpeed) {
  const upload = formatSpeed(uploadSpeed)
  const download = formatSpeed(downloadSpeed)
  // Layout: 134×44 @2x, icon 40×40 left, text right-aligned
  const W = 134,
    H = 44,
    ICON = 36
  const iconScale = ICON / 32 // tray.svg is 32×32
  const iconY = (H - ICON) / 2
  const fontSize = 18,
    lineHeight = 20
  const textTop = (H - 2 * lineHeight) / 2
  const uploadY = textTop + fontSize
  const downloadY = uploadY + lineHeight - 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <g transform="translate(0,${iconY}) scale(${iconScale})">${iconSvg}</g>
  <text x="${W - 2}" y="${uploadY}" text-anchor="end" font-family="Helvetica,sans-serif" font-size="${fontSize}" fill="black">${upload}</text>
  <text x="${W - 2}" y="${downloadY}" text-anchor="end" font-family="Helvetica,sans-serif" font-size="${fontSize}" fill="black">${download}</text>
</svg>`
}

// ─── SVG Sources ────────────────────────────────────────────

const rawSvg = readFileSync(
  path.join(projectRoot, 'extra/tray/tray.svg'),
  'utf-8'
)
const templateSvg = rawSvg.replace(/fill="[^"]*"/g, 'fill="black"')

// ─── Render Helpers ─────────────────────────────────────────

// Load fonts as buffers — resvg-wasm can't access filesystem for fonts
const sfW400 = readFileSync(path.join(projectRoot, 'extra/tray/SFNS-w400.ttf'))
const sfW450 = readFileSync(path.join(projectRoot, 'extra/tray/SFNS-w450.ttf'))
const sfW500 = readFileSync(path.join(projectRoot, 'extra/tray/SFNS-w500.ttf'))
const sfW600 = readFileSync(path.join(projectRoot, 'extra/tray/SFNS-w600.ttf'))
const helveticaFont = readFileSync('/System/Library/Fonts/Helvetica.ttc')
console.log('Loaded weight variants: w400, w450, w500, w600 + Helvetica')

function renderSvg(svg, opts = {}) {
  const { font: fontOpts, ...restOpts } = opts
  const resvg = new Resvg(svg, {
    font: {
      fontBuffers: [sfW400, helveticaFont],
      defaultFontFamily: '.SF NS',
      ...fontOpts,
    },
    ...restOpts,
  })
  return Buffer.from(resvg.render().asPng())
}

// ─── Output ─────────────────────────────────────────────────

const outDir = path.join(__dirname, 'out')
mkdirSync(outDir, { recursive: true })

function save(name, png) {
  const filePath = path.join(outDir, name)
  writeFileSync(filePath, png)
  console.log(`  ✓ ${name} (${png.length} bytes)`)
}

// ─── Test Cases ─────────────────────────────────────────────

console.log('\nRendering tray icon states...\n')

// 1. Original colored icon (as-is from SVG)
save(
  '01-icon-original.png',
  renderSvg(rawSvg, { fitTo: { mode: 'width', value: 64 } })
)

// 2. Template icon (all black — macOS template image)
save(
  '02-icon-template.png',
  renderSvg(templateSvg, { fitTo: { mode: 'width', value: 64 } })
)

// 3. Template @2x (36x36 px — actual tray speedometer icon size)
save(
  '03-icon-template-2x.png',
  renderSvg(templateSvg, { fitTo: { mode: 'width', value: 36 } })
)

console.log('\nRendering speedometer states...\n')

// Speed test cases: [name, uploadBytes, downloadBytes]
const speedCases = [
  ['04-speed-idle', 0, 0],
  ['05-speed-slow', 50 * 1024, 200 * 1024],
  ['06-speed-medium', 1.2 * 1024 ** 2, 5.8 * 1024 ** 2],
  ['07-speed-fast', 15.3 * 1024 ** 2, 98.7 * 1024 ** 2],
  ['08-speed-extreme', 500 * 1024 ** 2, 1.2 * 1024 ** 3],
  ['09-speed-upload-only', 3.5 * 1024 ** 2, 0],
  ['10-speed-download-only', 0, 12.4 * 1024 ** 2],
  ['11-speed-bytes', 128, 512],
]

for (const [name, upload, download] of speedCases) {
  const svg = buildSpeedometerSvg(templateSvg, upload, download)
  // SVG is already @2x (134×44), render at native size
  const png = renderSvg(svg)
  save(`${name}.png`, png)
}

// ─── Font Comparison ────────────────────────────────────────
console.log(
  '\nRendering font comparison (medium speed: 15 MB/s / 88 MB/s)...\n'
)

const testUp = 15 * 1024 ** 2
const testDown = 88 * 1024 ** 2

// Each weight variant uses its own font buffer as the sole SF source
const weightVariants = [
  ['12-sfpro-w400', sfW400, 'Regular (400)'],
  ['13-sfpro-w450', sfW450, 'Book (450)'],
  ['14-sfpro-w500', sfW500, 'Medium (500)'],
  ['15-sfpro-w600', sfW600, 'Semibold (600)'],
]

for (const [prefix, fontBuf, label] of weightVariants) {
  const W = 136,
    H = 44,
    ICON = 36
  const iconScale = ICON / 32
  const iconY = (H - ICON) / 2
  const fontSize = 18,
    lineHeight = 20
  const textTop = (H - 2 * lineHeight) / 2
  const uploadY = textTop + fontSize
  const downloadY = uploadY + lineHeight - 2
  const upload = formatSpeed(testUp)
  const download = formatSpeed(testDown)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <g transform="translate(0,${iconY}) scale(${iconScale})">${templateSvg}</g>
  <text x="${W - 2}" y="${uploadY}" text-anchor="end" font-family=".SF NS,Helvetica,sans-serif" font-size="${fontSize}" fill="black">${upload}</text>
  <text x="${W - 2}" y="${downloadY}" text-anchor="end" font-family=".SF NS,Helvetica,sans-serif" font-size="${fontSize}" fill="black">${download}</text>
</svg>`
  const resvg = new Resvg(svg, {
    font: {
      fontBuffers: [fontBuf, helveticaFont],
      defaultFontFamily: '.SF NS',
    },
  })
  save(`${prefix}.png`, Buffer.from(resvg.render().asPng()))
  console.log(`    ${label}`)
}

// ─── Summary ────────────────────────────────────────────────

console.log(`\n✓ All renders saved to: ${outDir}\n`)
console.log('Speed format verification:')
for (const [name, upload, download] of speedCases) {
  console.log(`  ${name}: ↑ ${formatSpeed(upload)}  ↓ ${formatSpeed(download)}`)
}
console.log()
