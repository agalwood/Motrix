import type { BrowserWindowConstructorOptions } from 'electron'

export interface PlatformOptionsInput {
  vibrancy?: boolean
  liquidGlass?: boolean
  shouldUseDarkColors?: boolean
  windowControlsSymbolColor?: string
}

export const WINDOWS_TITLE_BAR_OVERLAY_HEIGHT = 54

export function getWindowsWindowControlsSymbolColor(
  shouldUseDarkColors: boolean
): string {
  return shouldUseDarkColors ? '#f5f5f5' : '#1d1d1f'
}

export function buildPlatformOptions(
  platform: string = process.platform,
  {
    vibrancy = true,
    liquidGlass = false,
    shouldUseDarkColors = false,
    windowControlsSymbolColor,
  }: PlatformOptionsInput = {}
): BrowserWindowConstructorOptions {
  switch (platform) {
    case 'darwin':
      if (liquidGlass) {
        return {
          titleBarStyle: 'hiddenInset',
          transparent: true,
          backgroundColor: '#00000000',
          trafficLightPosition: { x: 20, y: 20 },
        }
      }
      return vibrancy
        ? {
            titleBarStyle: 'hiddenInset',
            vibrancy: 'under-window',
            visualEffectState: 'active',
            backgroundColor: '#00000000',
            trafficLightPosition: { x: 20, y: 20 },
          }
        : {
            titleBarStyle: 'hiddenInset',
            backgroundColor: '#ffffff',
            trafficLightPosition: { x: 20, y: 20 },
          }
    case 'win32':
      return {
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor:
            windowControlsSymbolColor ??
            getWindowsWindowControlsSymbolColor(shouldUseDarkColors),
          // The renderer's 28 px header actions are centered at y=27.
          // Matching that center keeps native caption buttons on their baseline.
          height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
        },
      }
    default:
      return {
        titleBarStyle: 'hidden',
      }
  }
}
