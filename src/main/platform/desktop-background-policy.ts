import { RunMode } from '@shared/constants'

export interface DesktopBackgroundPolicyInput {
  lightweightMode: boolean
  platform: NodeJS.Platform
  runMode: RunMode
}

export interface DesktopBackgroundPolicy {
  keepTray: boolean
  releaseMainWindowWhenHidden: boolean
}

/** Resolve the reopen surface and renderer-retention policy as one invariant. */
export function resolveDesktopBackgroundPolicy({
  lightweightMode,
  platform,
  runMode,
}: DesktopBackgroundPolicyInput): DesktopBackgroundPolicy {
  const keepTray =
    runMode !== RunMode.HideTray || (lightweightMode && platform !== 'darwin')

  return {
    keepTray,
    // macOS can reopen from the Dock. Windows/Linux lightweight mode forces
    // the tray above, so releasing the final renderer never removes every
    // discoverable reopen surface.
    releaseMainWindowWhenHidden:
      lightweightMode && (platform === 'darwin' || keepTray),
  }
}
