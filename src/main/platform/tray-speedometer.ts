import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getLogger } from '@core/logger'
import {
  type ByteUnitSystem,
  DEFAULT_BYTE_UNIT_SYSTEM,
} from '@shared/schemas/byte-unit-system'
import type { NativeImage, Tray } from 'electron'
import { nativeImage } from 'electron'
import { formatSpeed } from './tray-icon'

// ─── SVG Layout (@2x pixels, scaleFactor 2 → 72×22 pt) ─────
//
//  ┌─────────────────────────────────┐
//  │  ┌──────┐         1.23 MB/s    │
//  │  │ icon │         5.89 MB/s    │
//  │  │32×32 │     (right-aligned)  │
//  │  └──────┘                      │
//  └─────────────────────────────────┘
//    0    40  46                  144

const SVG_WIDTH = 144 // Four-digit speeds omit decimals to fit IEC labels
const SVG_HEIGHT = 44
const ICON_SIZE = 32
const ICON_SCALE = ICON_SIZE / 32 // tray.svg is 32×32
const ICON_Y = (SVG_HEIGHT - ICON_SIZE) / 2
const TEXT_RIGHT = SVG_WIDTH - 2 // right edge with 2px margin
const FONT_SIZE = 18
const LINE_HEIGHT = 20
const TEXT_BLOCK_HEIGHT = 2 * LINE_HEIGHT
const TEXT_TOP = (SVG_HEIGHT - TEXT_BLOCK_HEIGHT) / 2
const UPLOAD_Y = TEXT_TOP + FONT_SIZE // baseline of first line
const DOWNLOAD_Y = UPLOAD_Y + LINE_HEIGHT - 2 // baseline of second line

export function buildSpeedometerSvg(
  iconSvg: string,
  uploadSpeed: number,
  downloadSpeed: number,
  unitSystem: ByteUnitSystem = DEFAULT_BYTE_UNIT_SYSTEM
): string {
  const upload = formatSpeed(uploadSpeed, unitSystem)
  const download = formatSpeed(downloadSpeed, unitSystem)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}">
  <g transform="translate(0,${ICON_Y}) scale(${ICON_SCALE})">${iconSvg}</g>
  <text x="${TEXT_RIGHT}" y="${UPLOAD_Y}" text-anchor="end" font-family=".SF NS,Helvetica,sans-serif" font-size="${FONT_SIZE}" fill="black">${upload}</text>
  <text x="${TEXT_RIGHT}" y="${DOWNLOAD_Y}" text-anchor="end" font-family=".SF NS,Helvetica,sans-serif" font-size="${FONT_SIZE}" fill="black">${download}</text>
</svg>`
}

// ─── Speedometer Renderer ───────────────────────────────────

export interface SpeedometerHandle {
  onSpeedChange(uploadSpeed: number, downloadSpeed: number): void
  setEnabled(enabled: boolean): void
  setUnitSystem(unitSystem: ByteUnitSystem): void
  destroy(): void
}

type ResvgModule = typeof import('@resvg/resvg-wasm')
let resvgReady: Promise<ResvgModule> | undefined

function loadResvg(trayAssetDir: string): Promise<ResvgModule> {
  resvgReady ??= (async () => {
    const moduleName = '@resvg/resvg-wasm'
    const mod: ResvgModule = await import(/* @vite-ignore */ moduleName)
    await mod.initWasm(readFileSync(path.join(trayAssetDir, 'resvg.wasm')))
    return mod
  })().catch((error) => {
    resvgReady = undefined
    throw error
  })
  return resvgReady
}

const MACOS_FONT_PATHS = [
  'SFNS-Regular.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
]

export function createSpeedometer(
  trayRef: () => Tray | null,
  iconSvg: string,
  trayAssetDir: string
): SpeedometerHandle {
  let unitSystem = DEFAULT_BYTE_UNIT_SYSTEM
  let enabled = false
  let destroyed = false
  let revision = 0
  let request = 0
  let rendering = false
  let failureReported = false
  let lastSvg: string | null = null
  let throttleTimer: ReturnType<typeof setTimeout> | null = null
  let pendingUpload = 0
  let pendingDownload = 0
  let fontBuffers: Buffer[] | null = null

  async function render(): Promise<void> {
    const currentRevision = revision
    const tray = trayRef()
    if (!enabled || destroyed || !tray) return
    let svg = buildSpeedometerSvg(
      iconSvg,
      pendingUpload,
      pendingDownload,
      unitSystem
    )
    if (svg === lastSvg) return
    const { Resvg } = await loadResvg(trayAssetDir)
    if (
      !enabled ||
      destroyed ||
      revision !== currentRevision ||
      trayRef() !== tray
    )
      return
    svg = buildSpeedometerSvg(
      iconSvg,
      pendingUpload,
      pendingDownload,
      unitSystem
    )
    if (svg === lastSvg) return
    if (!fontBuffers) {
      fontBuffers = []
      for (const file of MACOS_FONT_PATHS) {
        try {
          fontBuffers.push(
            readFileSync(
              path.isAbsolute(file) ? file : path.join(trayAssetDir, file)
            )
          )
        } catch {
          /* Use whichever platform fonts are available. */
        }
      }
    }
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: SVG_WIDTH },
      font: { fontBuffers, defaultFontFamily: '.SF NS' },
    })
    let png: Buffer
    try {
      const rendered = resvg.render()
      try {
        // The native image must never borrow storage owned by a freed WASM object.
        png = Buffer.from(rendered.asPng())
      } finally {
        rendered.free()
      }
    } finally {
      resvg.free()
    }
    const image: NativeImage = nativeImage.createFromBuffer(png, {
      scaleFactor: 2,
    })
    image.setTemplateImage(true)
    tray.setImage(image)
    lastSvg = svg
    failureReported = false
  }

  function scheduleRender(): void {
    if (!enabled || destroyed || throttleTimer || rendering) return
    throttleTimer = setTimeout(() => {
      throttleTimer = null
      const startedRequest = request
      rendering = true
      void render()
        .catch((err) => {
          if (!destroyed && enabled && !failureReported) {
            failureReported = true
            getLogger('tray-speedometer').warn(
              { err },
              'speedometer render failed'
            )
          }
        })
        .finally(() => {
          rendering = false
          if (request !== startedRequest) scheduleRender()
        })
    }, 500)
  }

  function invalidate(): void {
    revision++
    request++
    lastSvg = null
    if (throttleTimer) clearTimeout(throttleTimer)
    throttleTimer = null
  }

  return {
    onSpeedChange(uploadSpeed, downloadSpeed) {
      if (!enabled || destroyed) return
      pendingUpload = uploadSpeed
      pendingDownload = downloadSpeed
      request++
      scheduleRender()
    },
    setUnitSystem(value) {
      if (destroyed || unitSystem === value) return
      unitSystem = value
      invalidate()
      scheduleRender()
    },
    setEnabled(value) {
      if (destroyed || enabled === value) return
      enabled = value
      invalidate()
      if (!enabled) fontBuffers = null
    },
    destroy() {
      destroyed = true
      enabled = false
      invalidate()
      fontBuffers = null
    },
  }
}
