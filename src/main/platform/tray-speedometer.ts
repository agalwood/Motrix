import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { NativeImage, Tray } from 'electron'
import { nativeImage } from 'electron'
import { formatSpeed } from './tray-icon'

// ─── SVG Layout (@2x pixels, scaleFactor 2 → 68×22 pt) ─────
//
//  ┌─────────────────────────────────┐
//  │  ┌──────┐          1.2 MB/s    │
//  │  │ icon │          5.8 MB/s    │
//  │  │36×36 │     (right-aligned)  │
//  │  └──────┘                      │
//  └─────────────────────────────────┘
//    0    40  46                  134

const SVG_WIDTH = 134
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
  downloadSpeed: number
): string {
  const upload = formatSpeed(uploadSpeed)
  const download = formatSpeed(downloadSpeed)

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
  destroy(): void
}

type ResvgModule = {
  Resvg: new (
    svg: string,
    opts: object
  ) => { render(): { asPng(): Uint8Array } }
  initWasm(): Promise<void>
}

// SF Pro static (converted from variable SFNS.ttf) + Helvetica fallback
const MACOS_FONT_PATHS = [
  'SFNS-Regular.ttf', // relative to trayAssetDir
  '/System/Library/Fonts/Helvetica.ttc',
]

export function createSpeedometer(
  trayRef: () => Tray | null,
  iconSvg: string,
  trayAssetDir: string
): SpeedometerHandle {
  let enabled = false
  let lastUpload = -1
  let lastDownload = -1
  let throttleTimer: ReturnType<typeof setTimeout> | null = null
  let pendingUpload = 0
  let pendingDownload = 0
  let resvgModule: ResvgModule | null = null
  let fontBuffers: Buffer[] | null = null

  async function ensureResvg(): Promise<ResvgModule> {
    if (resvgModule) return resvgModule
    const resvgModuleName = '@resvg/resvg-wasm'
    const mod = await import(/* @vite-ignore */ resvgModuleName)
    try {
      const wasmBinary = readFileSync(path.join(trayAssetDir, 'resvg.wasm'))
      await mod.initWasm(wasmBinary)
    } catch {
      // Already initialized
    }
    resvgModule = mod as ResvgModule
    return resvgModule
  }

  async function render(upload: number, download: number) {
    if (upload === lastUpload && download === lastDownload) return
    lastUpload = upload
    lastDownload = download

    const tray = trayRef()
    if (!tray) return

    const svg = buildSpeedometerSvg(iconSvg, upload, download)
    const { Resvg } = await ensureResvg()
    // Load fonts once — resvg-wasm can't access filesystem for fonts
    if (!fontBuffers) {
      fontBuffers = []
      for (const p of MACOS_FONT_PATHS) {
        try {
          // First entry is relative to trayAssetDir, rest are absolute
          const fullPath = path.isAbsolute(p) ? p : path.join(trayAssetDir, p)
          fontBuffers.push(readFileSync(fullPath))
        } catch {
          // Font not available
        }
      }
    }
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: SVG_WIDTH },
      font: {
        fontBuffers,
        defaultFontFamily: '.SF NS',
      },
    })
    const png = resvg.render().asPng()
    const image: NativeImage = nativeImage.createFromBuffer(Buffer.from(png), {
      scaleFactor: 2,
    })
    image.setTemplateImage(true)
    tray.setImage(image)
  }

  function scheduleRender() {
    if (throttleTimer) return
    throttleTimer = setTimeout(() => {
      throttleTimer = null
      render(pendingUpload, pendingDownload)
    }, 500)
  }

  return {
    onSpeedChange(uploadSpeed: number, downloadSpeed: number) {
      if (!enabled) return
      pendingUpload = uploadSpeed
      pendingDownload = downloadSpeed
      scheduleRender()
    },

    setEnabled(value: boolean) {
      enabled = value
      if (!enabled) {
        lastUpload = -1
        lastDownload = -1
        if (throttleTimer) {
          clearTimeout(throttleTimer)
          throttleTimer = null
        }
      }
    },

    destroy() {
      if (throttleTimer) {
        clearTimeout(throttleTimer)
        throttleTimer = null
      }
    },
  }
}
