/** Renderer-drawn title-bar geometry for surfaces without native WCO. */
export const DESKTOP_WINDOW_CHROME_HEIGHT = 40
/** Full title bar centered on the native caption row (macOS lights: y=20, diameter=14). */
export const NATIVE_TITLE_BAR_HEIGHT = 54
/** Linux reserves the full title bar for its native controls overlay. */
export const WINDOW_CONTROLS_OVERLAY_HEIGHT = NATIVE_TITLE_BAR_HEIGHT
export const WINDOW_CHROME_EDGE_GAP = 16

export function windowChromeHeight(platform: string, compact: boolean): number {
  return platform === 'linux' || (platform === 'darwin' && !compact)
    ? NATIVE_TITLE_BAR_HEIGHT
    : DESKTOP_WINDOW_CHROME_HEIGHT
}
