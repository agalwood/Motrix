import { extensionBrowser } from '@/shared/browser'

// A client claim only. The backend requires a valid native ticket before
// assigning the signed bundle's identity to the Safari installation Origin.
export const SAFARI_EXTENSION_ID = 'app.motrix.safari.extension'

export function hasPackagedSafariNativeMessaging(): boolean {
  try {
    return (
      extensionBrowser.runtime
        .getManifest()
        .permissions?.includes('nativeMessaging') === true &&
      typeof extensionBrowser.runtime.sendNativeMessage === 'function'
    )
  } catch {
    return false
  }
}
