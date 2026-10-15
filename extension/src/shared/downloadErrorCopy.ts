import { DOWNLOAD_ERROR } from '@/shared/integration'

export function downloadErrorKey(error: unknown): string {
  const reason = error instanceof Error ? error.message : error
  switch (reason) {
    case DOWNLOAD_ERROR.resultUnknown:
      return 'popup.integration.resultUnknown'
    case DOWNLOAD_ERROR.pairingRequired:
      return 'popup.integration.pairingRequired'
    case DOWNLOAD_ERROR.connectionFailed:
    case DOWNLOAD_ERROR.preparationTimeout:
      return 'popup.integration.connectionFailed'
    case DOWNLOAD_ERROR.contextChanged:
    case DOWNLOAD_ERROR.endpointChanged:
      return 'popup.integration.contextChanged'
    case DOWNLOAD_ERROR.unsupported:
      return 'popup.sniffer.unsupportedSelectionReason'
    default:
      return 'popup.sniffer.submitFailed'
  }
}
