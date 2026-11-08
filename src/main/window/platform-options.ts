import { WINDOW_CONTROLS_OVERLAY_HEIGHT } from '@shared/constants/window-chrome'
import type { BrowserWindowConstructorOptions } from 'electron'

export interface PlatformOptionsInput {
  vibrancy?: boolean
  liquidGlass?: boolean
  shouldUseDarkColors?: boolean
}

export const WINDOW_BACKGROUND = {
  light: '#ffffff',
  dark: '#09090b',
} as const

export function buildWindowControlsOverlay(shouldUseDarkColors: boolean) {
  return {
    // Electron 45 forces this RGB opaque when deriving Breeze inverse glyphs.
    // Keep alpha zero for the renderer surface, but supply its resolved tone.
    color: `${shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light}00`,
    symbolColor: shouldUseDarkColors ? '#fafafa' : '#262626',
    height: WINDOW_CONTROLS_OVERLAY_HEIGHT,
  }
}

export function buildPlatformOptions(
  platform: string = process.platform,
  {
    vibrancy = true,
    liquidGlass = false,
    shouldUseDarkColors = false,
  }: PlatformOptionsInput = {}
): BrowserWindowConstructorOptions {
  const solidBackground = shouldUseDarkColors
    ? WINDOW_BACKGROUND.dark
    : WINDOW_BACKGROUND.light

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
            backgroundColor: solidBackground,
            trafficLightPosition: { x: 20, y: 20 },
          }
    case 'linux':
      return {
        titleBarStyle: 'hidden',
        titleBarOverlay: buildWindowControlsOverlay(shouldUseDarkColors),
        backgroundColor: solidBackground,
      }
    default:
      return {
        titleBarStyle: 'hidden',
        backgroundColor: solidBackground,
      }
  }
}
