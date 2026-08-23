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
  // HideTray is a macOS-only mode because the Dock remains a reliable reopen
  // surface there. Windows and Linux must always keep the tray, including for
  // stale or manually edited settings that contain the unsupported value.
  const keepTray = platform !== 'darwin' || runMode !== RunMode.HideTray

  return {
    keepTray,
    // macOS can reopen from the Dock. Windows/Linux lightweight mode forces
    // the tray above, so releasing the final renderer never removes every
    // discoverable reopen surface.
    releaseMainWindowWhenHidden:
      lightweightMode && (platform === 'darwin' || keepTray),
  }
}
