import type { Platform } from './native-messaging-installer'

export const MOTRIX_FLATPAK_ID = 'app.motrix.native'

export interface FlatpakEnvironmentOptions {
  platform: Platform
  isPackaged: boolean
  env: NodeJS.ProcessEnv
}

/**
 * A host browser cannot execute an `/app/...` path from the Flatpak sandbox.
 * Treat Native Messaging registration as externally managed so the app
 * neither installs a broken host path nor removes a future companion's
 * host-side manifest.
 */
export function isPackagedLinuxFlatpak(
  options: FlatpakEnvironmentOptions
): boolean {
  return (
    options.platform === 'linux' &&
    options.isPackaged &&
    options.env.FLATPAK_ID === MOTRIX_FLATPAK_ID
  )
}
