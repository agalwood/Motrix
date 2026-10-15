export type PairingState = 'loading' | 'none' | 'stored' | 'unavailable'

export interface RpcStatus {
  health: 'healthy' | 'checking' | 'unresponsive'
  lastError: {
    method: string
    at: number
    elapsedMs: number
    generation: number
  } | null
  lastSuccessAt: number | null
}

export type ConnectionIntent =
  | 'background-probe'
  | 'automatic-download'
  | 'explicit-download'
  | 'view-tasks'
  | 'retry-connection'
  | 'first-pair'

export type ConnectionPhase =
  | 'idle'
  | 'probing'
  | 'waking'
  | 'authenticating'
  | 'initializing'
  | 'ready'

export type DownloadOperationState =
  | 'preparing'
  | 'submitting'
  | 'accepted'
  | 'failed'
  | 'unknown'

/** Session-only recovery metadata. Never include download URLs or credentials. */
export interface DownloadOperation {
  id: string
  endpointId: string
  source: 'media' | 'page' | 'manual' | 'direct'
  state: DownloadOperationState
  updatedAt: number
  taskId?: string
  reason?: string
}

export const DOWNLOAD_ERROR = {
  directoryUnavailable: 'download.directory-unavailable',
  pairingRequired: 'download.pairing-required',
  connectionFailed: 'download.connection-failed',
  preparationTimeout: 'download.preparation-timeout',
  endpointChanged: 'download.endpoint-changed',
  unsupported: 'download.unsupported',
  contextChanged: 'download.context-changed',
  resultUnknown: 'download.result-unknown',
  rejected: 'download.rejected',
  interrupted: 'download.interrupted',
} as const

export type DownloadErrorReason =
  (typeof DOWNLOAD_ERROR)[keyof typeof DOWNLOAD_ERROR]

export function isDownloadErrorReason(
  value: unknown
): value is DownloadErrorReason {
  return Object.values(DOWNLOAD_ERROR).some((reason) => reason === value)
}

export const DOWNLOAD_OPERATION_TTL_MS = 30 * 60_000

/** A timestamp bounds replay safety after session records have expired. */
export function newDownloadOperationId(): string {
  return `${Date.now().toString(36)}:${crypto.randomUUID()}`
}

export function downloadOperationIssuedAt(id: string): number | null {
  const match = /^([a-z0-9]+):[a-zA-Z0-9-]{8,}$/.exec(id)
  if (!match?.[1]) return null
  const at = Number.parseInt(match[1], 36)
  return Number.isSafeInteger(at) && at > 0 ? at : null
}
