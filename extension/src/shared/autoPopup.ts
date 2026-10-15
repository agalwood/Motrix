export const POPUP_PORT = 'motrix.popup.presence'
export const POPUP_RECEIPT_EVENT = 'event.popupReceipt'

export interface PopupReceipt {
  operationId: string
  taskId: string
  endpointId: string
  endpointRevision: number
  windowId: number
  count: number
  expiresAt: number
}
