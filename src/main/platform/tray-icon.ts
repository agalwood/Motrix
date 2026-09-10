import path from 'node:path'
import type { NativeImage } from 'electron'
import { nativeImage, nativeTheme } from 'electron'

// ─── formatSpeed (exported for testing) ─────────────────────

export { formatSpeed } from '@shared/utils/format-bytes'

// ─── TrayIconProvider interface ─────────────────────────────

export interface TrayIconProvider {
  init(): Promise<void>
  getIcon(active: boolean): NativeImage
  invalidate(): void
}

// ─── macOS: static PNG template icon ────────────────────────
// Uses a pre-rendered PNG instead of runtime SVG→WASM→PNG rendering.
// The dark-background variant's alpha mask works as a macOS template image —
// the system supplies the tint automatically for light/dark mode.
// WASM is only loaded later if the speedometer is enabled.

export function createMacOSIconProvider(
  _svgPath: string,
  trayAssetDir: string
): TrayIconProvider {
  let cachedIcon: NativeImage | null = null

  return {
    async init() {
      const pngPath = path.join(trayAssetDir, 'mo-tray-dark-normal.png')
      cachedIcon = nativeImage.createFromPath(pngPath)
      cachedIcon.setTemplateImage(true)
    },

    getIcon(_active: boolean): NativeImage {
      // macOS uses a single template image —
      // active state not distinguished by icon
      if (!cachedIcon) {
        throw new Error('TrayIconProvider not initialized')
      }
      return cachedIcon
    },

    invalidate() {
      cachedIcon = null
    },
  }
}

// ─── Windows: colorful PNG icons ────────────────────────────

export function createWindowsIconProvider(
  trayAssetDir: string
): TrayIconProvider {
  let normalIcon: NativeImage | null = null
  let activeIcon: NativeImage | null = null

  return {
    async init() {
      const ext = '.ico'
      normalIcon = nativeImage.createFromPath(
        path.join(trayAssetDir, `mo-tray-colorful-normal${ext}`)
      )
      activeIcon = nativeImage.createFromPath(
        path.join(trayAssetDir, `mo-tray-colorful-active${ext}`)
      )
    },

    getIcon(active: boolean): NativeImage {
      const icon = active ? activeIcon : normalIcon
      if (!icon) throw new Error('TrayIconProvider not initialized')
      return icon
    },

    invalidate() {
      // Windows icons are static PNGs — no cache to invalidate
    },
  }
}

// ─── Linux: themed PNG icons ────────────────────────────────

export function createLinuxIconProvider(
  trayAssetDir: string
): TrayIconProvider {
  let normalIcon: NativeImage | null = null
  let activeIcon: NativeImage | null = null

  function getThemePrefix(): string {
    // Asset names describe the background: dark uses white artwork and vice versa.
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }

  return {
    async init() {
      const theme = getThemePrefix()
      normalIcon = nativeImage.createFromPath(
        path.join(trayAssetDir, `mo-tray-${theme}-normal.png`)
      )
      activeIcon = nativeImage.createFromPath(
        path.join(trayAssetDir, `mo-tray-${theme}-active.png`)
      )
    },

    getIcon(active: boolean): NativeImage {
      const icon = active ? activeIcon : normalIcon
      if (!icon) throw new Error('TrayIconProvider not initialized')
      return icon
    },

    invalidate() {
      normalIcon = null
      activeIcon = null
    },
  }
}

// ─── Factory ────────────────────────────────────────────────

export function createIconProvider(
  svgPath: string,
  trayAssetDir: string
): TrayIconProvider {
  switch (process.platform) {
    case 'darwin':
      return createMacOSIconProvider(svgPath, trayAssetDir)
    case 'win32':
      return createWindowsIconProvider(trayAssetDir)
    default:
      return createLinuxIconProvider(trayAssetDir)
  }
}
