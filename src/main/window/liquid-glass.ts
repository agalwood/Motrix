import { getLogger } from '@core/logger'
import type { SettingsManager } from '@core/settings/settings-manager'
import { type BrowserWindow, nativeTheme } from 'electron'
import type { WindowId } from './window-configs'

const log = getLogger('liquid-glass')

interface GlassOptions {
  cornerRadius?: number
  tintColor?: string
  opaque?: boolean
}

interface LiquidGlass {
  addView(handle: Buffer, options?: GlassOptions): number
}

interface LiquidGlassModule {
  default?: LiquidGlass
}

export interface LiquidGlassControllerDeps {
  settingsManager: SettingsManager
}

type ProcessWithSystemVersion = NodeJS.Process & {
  getSystemVersion?: () => string
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as <
  T,
>(
  specifier: string
) => Promise<T>

let liquidGlassPromise: Promise<LiquidGlass | null> | null = null

export function isMacOS26OrLater(
  platform: NodeJS.Platform = process.platform,
  systemVersion = (process as ProcessWithSystemVersion).getSystemVersion?.()
): boolean {
  if (platform !== 'darwin' || !systemVersion) return false
  const [major] = systemVersion.split('.')
  const majorVersion = Number(major)
  return Number.isInteger(majorVersion) && majorVersion >= 26
}

export function shouldEnableLiquidGlassByDefault({
  isDev,
  platform = process.platform,
  systemVersion = (process as ProcessWithSystemVersion).getSystemVersion?.(),
}: {
  isDev: boolean
  platform?: NodeJS.Platform
  systemVersion?: string
}): boolean {
  return !isDev && isMacOS26OrLater(platform, systemVersion)
}

export function shouldUseLiquidGlassAtRuntime(
  enabled: boolean,
  platform: NodeJS.Platform = process.platform
): boolean {
  return enabled && platform === 'darwin'
}

async function loadLiquidGlass(): Promise<LiquidGlass | null> {
  if (!liquidGlassPromise) {
    liquidGlassPromise = dynamicImport<LiquidGlassModule>(
      'electron-liquid-glass'
    )
      .then((mod) => mod.default ?? null)
      .catch((err) => {
        log.warn({ err }, 'electron-liquid-glass unavailable')
        return null
      })
  }
  return liquidGlassPromise
}

export class LiquidGlassController {
  private readonly applied = new WeakSet<BrowserWindow>()

  constructor(private readonly deps: LiquidGlassControllerDeps) {}

  shouldUseLiquidGlass(): boolean {
    return shouldUseLiquidGlassAtRuntime(
      this.deps.settingsManager.getApp().liquidGlassEffect
    )
  }

  attach(id: WindowId, win: BrowserWindow): void {
    if (!this.shouldUseLiquidGlass()) return

    win.setWindowButtonVisibility(true)
    win.webContents.once('did-finish-load', () => {
      void this.apply(id, win)
    })
  }

  private getGlassTint() {
    return nativeTheme.shouldUseDarkColors ? '#F2F4F818' : '#DCE8FF1A'
  }

  private async apply(id: WindowId, win: BrowserWindow): Promise<void> {
    if (win.isDestroyed() || this.applied.has(win)) return

    const liquidGlass = await loadLiquidGlass()
    if (!liquidGlass || win.isDestroyed()) return

    try {
      // electron-liquid-glass selects native glass on macOS 26+ and falls
      // back internally on older macOS releases. Do not pre-empt that path
      // with a second support check here.
      const glassId = liquidGlass.addView(win.getNativeWindowHandle(), {
        cornerRadius: 0,
        tintColor: this.getGlassTint(),
      })
      this.applied.add(win)
      log.info({ glassId, windowId: id }, 'applied liquid glass effect')
    } catch (err) {
      log.warn({ err, windowId: id }, 'failed to apply liquid glass effect')
    }
  }
}
