import type { BrowserWindowConstructorOptions } from 'electron'

export interface PlatformOptionsInput {
  vibrancy?: boolean
  liquidGlass?: boolean
}

export function buildPlatformOptions(
  platform: string = process.platform,
  { vibrancy = true, liquidGlass = false }: PlatformOptionsInput = {}
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
      }
    default:
      return {
        titleBarStyle: 'hidden',
      }
  }
}
