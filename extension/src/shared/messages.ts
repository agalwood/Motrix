import type {
  DownloadCancelParams,
  DownloadCancelResult,
  DownloadSubmitParams,
  DownloadSubmitResult,
  EngineStatusParams,
  EngineStatusResult,
  StatsGetParams,
  StatsResult,
  TaskGetParams,
  TaskGetResult,
  TaskListParams,
  TaskListResult,
  TaskPauseParams,
  TaskPauseResult,
  TaskRemoveParams,
  TaskRemoveResult,
  TaskResumeParams,
  TaskResumeResult,
  TaskRevealParams,
  TaskRevealResult,
  UrlResolveParams,
  UrlResolveResult,
} from '@motrix/mdxp'
import type {
  ConnectionState,
  PairCandidate,
  ServerIdentity,
} from '@/background/ConnectionManager'
import type {
  EndpointConfig,
  MotrixServerEndpoint,
} from '@/background/EndpointConfigStore'
import type { CreateManualTaskRequest } from '@/shared/manualTask'

export interface CallerIdempotencyRequest {
  pairIfNeeded?: boolean

  idempotencyKey: string
}

export const MEDIA_SUBMIT_ERROR = {
  invalidRequest: 'media-submit.invalid-request',
  submitFailed: 'media-submit.submit-failed',
} as const

/**
 * Background ⇆ Popup/Options ⇆ Content messages.
 *
 * Each direction uses `browser.runtime.sendMessage` (popup/options ↔ bg)
 * or `browser.tabs.sendMessage` (bg ↔ content). All payloads must be
 * JSON-serializable.
 */
export interface MessageMap {
  'bg.getDownloadDirectories': {
    request: undefined
    response: import('@/shared/downloadDirectories').DownloadDirectoriesResponse
  }
  // popup / options → background
  'bg.runConnectionDiagnostics': {
    request: { endpointId: string | null }
    response: import('@/shared/connectionDiagnostics').ConnectionDiagnosticResult
  }
  'bg.getState': {
    request: undefined
    response: {
      rpc?: import('@/shared/integration').RpcStatus
      state: ConnectionState
      endpoint: EndpointConfig
      pairing: import('@/shared/integration').PairingState
      phase: import('@/shared/integration').ConnectionPhase
      attemptIntent: import('@/shared/integration').ConnectionIntent | null
      lastError?: string
      /** The failed attempt's stable reason code
       *  (`PairingFailureReason`/`ReconnectFailureReason`), when the error
       *  was typed. The popup renders locale copy keyed by this — never the
       *  developer-facing `lastError` sentence. Same presence rule as
       *  `lastError`. */
      lastErrorReason?: string
      server?: ServerIdentity
      /**
       * Present exactly while a first-pair `PairingCodeProvider` call is
       * outstanding — i.e. the popup should be showing the code-entry
       * prompt right now. `deadlineMs` is an absolute timestamp (not a
       * duration), so re-polling doesn't restart the clock; `run`/`maxRuns`
       * are 1-based/§6.5's ceiling, read here rather than counted in the UI.
       * `attemptsRemaining` is the peer's last claim — display only, never
       * a signal.
       */
      pairingCode?: {
        run: number
        maxRuns: number
        attemptsRemaining: number | null
        deadlineMs: number
      }
      /** Present exactly on a §7.3 `backoffLocked` failure. `retryAtMs` is
       *  always the client's own `FirstPairBackoff` value, never anything
       *  the peer reported. */
      backoff?: { retryAtMs: number }
      /**
       * `true` exactly when the last attempt was an unattended one
       * (autostart, or the automatic post-close probe-reconnect) whose
       * recovery order was exhausted — §6.7/§12 correctly refused to fall
       * back to fresh code-entry pairing on its own. Surfaced as its own
       * flag, not folded into `lastError`, so the popup can show presentable
       * copy instead of `RecoveryExhaustedUnattendedError`'s own developer
       * message — the same treatment `backoff` already gets.
       */
      recoveryExhaustedUnattended?: boolean
      /**
       * `true` exactly when this session's pairing completed with no
       * native-host attestation ticket (the host degraded to ticketless),
       * not the §5 identity tri-state (that is the server's own verdict and
       * never reaches the client). Omitted when unknown (no first-pair has
       * run this session) or `false`.
       */
      degraded?: boolean
      /** Desktop-shell capabilities from the authenticated initialize
       *  handshake. Older Motrix builds omit taskReveal, which the
       *  background normalizes to false. */
      capabilities?: {
        taskReveal: boolean
        downloadDirectories?: boolean
      }
    }
  }
  'bg.getDownloadOperations': {
    request: { endpointId: string; endpointRevision?: number }
    response: import('@/shared/integration').DownloadOperation[]
  }
  'bg.getRecentActivity': {
    request: undefined
    response: {
      events: Array<{ at: number; kind: string; detail: string }>
    }
  }
  'bg.viewTasks': { request: undefined; response: { ok: true } }
  'bg.reconnect': { request: undefined; response: { ok: true } }
  'bg.clearBadgeError': { request: undefined; response: { ok: true } }
  'bg.getEndpointConfig': {
    request: undefined
    response: EndpointConfig
  }
  'bg.activateEndpoint': {
    request: { endpointId: string }
    response: { config: EndpointConfig }
  }
  'bg.addServer': {
    request: Pick<MotrixServerEndpoint, 'name' | 'url'>
    response: { config: EndpointConfig; server: MotrixServerEndpoint }
  }
  'bg.updateServer': {
    request: {
      endpointId: string
      expected: Pick<MotrixServerEndpoint, 'name' | 'url' | 'revision'>
      changes: Pick<MotrixServerEndpoint, 'name' | 'url'>
    }
    response: {
      config: EndpointConfig
      server: MotrixServerEndpoint
      urlChanged: boolean
      active: boolean
    }
  }
  'bg.removeServer': {
    request: {
      endpointId: string
      expected: Pick<MotrixServerEndpoint, 'name' | 'url' | 'revision'>
    }
    response: { config: EndpointConfig; wasActive: boolean }
  }
  'bg.getPairingStatus': {
    request: { endpointId: string }
    response: { paired: boolean }
  }
  'bg.hasPairedBackend': {
    request: undefined
    response: { paired: boolean }
  }
  'bg.getRemoteBackendPolicy': {
    request: undefined
    response: {
      policy:
        | import('@/background/RemoteBackendPolicyStore').RemoteBackendPolicyV1
        | null
    }
  }
  'bg.replaceRemoteBackendPolicy': {
    request: import('@/background/RemoteBackendPolicyStore').RemoteBackendPolicyReplacement
    response: {
      policy: import('@/background/RemoteBackendPolicyStore').RemoteBackendPolicyV1
    }
  }
  'bg.patchTakeoverEnabled': {
    request: { enabled: boolean; consentAckVersion?: number }
    response: import('@/shared/takeover').TakeoverConfig
  }
  'bg.patchDownloadMode': {
    request: { downloadMode: import('@/shared/takeover').DownloadMode }
    response: import('@/shared/takeover').TakeoverConfig
  }
  'bg.getPopupReceipt': {
    request: { windowId: number }
    response: import('@/shared/autoPopup').PopupReceipt | null
  }
  'bg.patchTaskPanelPreference': {
    request: { openTaskPanelAfterSubmit: boolean }
    response: import('@/shared/takeover').TakeoverConfig
  }
  'bg.patchSiteExclusion': {
    request: { domain: string; excluded: boolean }
    response: import('@/shared/takeover').TakeoverConfig
  }
  'bg.getTakeoverConfig': {
    request: undefined
    response: import('@/shared/takeover').TakeoverConfig
  }
  'bg.setTakeoverConfig': {
    request: import('@/shared/takeover').TakeoverSettings
    response: { ok: true }
  }
  'bg.getNotificationsConfig': {
    request: undefined
    response: import('@/shared/notifications').NotificationsConfig
  }
  'bg.getNotificationCapability': {
    request: undefined
    response: import('@/shared/notifications').NotificationCapability
  }
  'bg.testNotification': {
    request: undefined
    response: {
      status: import('@/shared/notifications').NotificationTestResult
    }
  }
  'bg.openNotificationSettings': {
    request: undefined
    response: { opened: boolean }
  }
  'bg.setNotificationsConfig': {
    request: import('@/shared/notifications').NotificationsConfig
    response: { ok: true }
  }
  'bg.unpair': { request: { endpointId: string }; response: { ok: true } }
  // MV3 service workers idle out after ~30s with no inbound event; the popup
  // pings this every ~20s while the pairing code-entry prompt is open, since
  // that is the one long-lived, no-network-traffic window a mid-pairing
  // worker teardown would otherwise hit. The response body carries no
  // information — the inbound message itself is what resets the idle timer.
  'bg.pairHeartbeat': { request: undefined; response: { ok: true } }
  /** Sweeps for live local Motrix instances to pair with. Read-only — does
   *  not start pairing. Safe to call repeatedly (a picker's "rescan"). */
  'bg.listPairCandidates': {
    request: undefined
    response: { candidates: PairCandidate[] }
  }
  /** Commits to one discovered candidate and starts a first-pair attempt
   *  against it. Returns once the attempt has been *started*, not once
   *  pairing finishes — a full session can take minutes; poll `bg.getState`
   *  for progress and for the `pairingCode` prompt that follows. */
  'bg.chooseCandidate': {
    request: { port: number }
    response: { ok: boolean; error?: string }
  }
  /** Answers the currently-outstanding `pairingCode` prompt from
   *  `bg.getState`, if any. `{ok: false}` when none is pending (the prompt
   *  already timed out, or nothing asked for a code) — the caller's own
   *  `request.timeoutMs` is enforced in the provider itself, not here. */
  'bg.submitPairingCode': {
    request: { code: string }
    response: { ok: boolean; error?: string }
  }
  'bg.listAdapters': {
    request: undefined
    response: {
      adapters: Array<{
        id: string
        version: string
        urlPatterns: string[]
      }>
    }
  }

  // popup → background → WS control-plane (paired session)
  'bg.taskList': { request: TaskListParams; response: TaskListResult }
  'bg.taskGet': { request: TaskGetParams; response: TaskGetResult }
  'bg.taskPause': { request: TaskPauseParams; response: TaskPauseResult }
  'bg.taskResume': { request: TaskResumeParams; response: TaskResumeResult }
  'bg.taskReveal': { request: TaskRevealParams; response: TaskRevealResult }
  'bg.taskRemove': { request: TaskRemoveParams; response: TaskRemoveResult }
  'bg.statsGet': { request: StatsGetParams; response: StatsResult }
  'bg.engineStatus': {
    request: EngineStatusParams
    response: EngineStatusResult
  }

  'bg.submitDownload': {
    request: DownloadSubmitParams
    response: DownloadSubmitResult
  }
  'bg.createManualTask': {
    request: CreateManualTaskRequest
    response: DownloadSubmitResult
  }
  'bg.cancelDownload': {
    request: DownloadCancelParams
    response: DownloadCancelResult
  }

  // background → content
  'content.resolve': {
    request: {
      url: string
      preferences?: UrlResolveParams['preferences']
    }
    response: UrlResolveResult
  }
  'content.imageThumbnail': {
    request: { url: string; maxEdge?: number }
    response: { dataUrl: string | null }
  }

  // content → background
  'bg.adapterAnnounce': {
    request: { adapterId: string; tabUrl: string }
    response: { ok: true }
  }

  // toolbar action → background: on-demand media scan
  'bg.scanActiveTab': {
    request: undefined
    response: {
      media: import('@/shared/media').DetectedMedia[]
      selectionKinds: string[]
    }
  }

  // content sniffer → background: report detected media items
  'bg.mediaDetected': {
    request: { tabUrl: string; items: import('@/shared/media').DetectedMedia[] }
    response: { ok: true }
  }

  // popup → background → isolated content script: sample a tiny raster
  // from an image the current page has already rendered. No network request is
  // made by this path; the public, anonymous fetch fallback stays in Popup.
  'bg.getMediaThumbnail': {
    request: { mediaKey: string }
    response: { dataUrl: string | null }
  }

  // popup → background → motrix: submit a detected media item for download
  'bg.submitMedia': {
    request: { mediaKey: string } & CallerIdempotencyRequest
    response: import('@motrix/mdxp').DownloadSubmitResult
  }

  // popup → background → motrix: resolve and submit the current tab's watch-page URL.
  // Used for bilibili/youtube watch pages that the generic sniffer cannot detect;
  // Motrix's resolveToMux seam handles the actual resolution server-side.
  // `qualityLabel` carries the grab overlay's format choice ('1080p' / 'mp3');
  // 'auto' and absent mean the desktop default format.
  'bg.resolvePageDownload': {
    request: CallerIdempotencyRequest & {
      qualityLabel?: import('@/shared/mediaFormats').QualityLabel
    }
    response: import('@motrix/mdxp').DownloadSubmitResult
  }

  // in-page grab overlay → background: what the overlay may offer for its tab
  'bg.grabberSnapshot': {
    request: undefined
    response: {
      connected: boolean
      media: Array<{
        key: string
        kind: import('@/shared/media').DetectedMedia['kind']
        label: string
        height?: number
        sizeBytes?: number
        mimeType?: string
      }>
    }
  }

  // in-page grab overlay → background → motrix: send one detected item
  'bg.grabberSubmit': {
    request: { mediaKey: string } & CallerIdempotencyRequest
    response: import('@motrix/mdxp').DownloadSubmitResult
  }

  // in-page grab overlay → background → motrix: list the yt-dlp qualities a
  // page URL offers (fork-local `media/formats` method). Never rejects —
  // a disconnected desktop or a listing failure comes back as
  // `{ connected, formats: { available: false, ... } }` so the overlay can
  // fall back to its sniffed rows.
  'bg.grabberFormats': {
    request: { url?: string } | undefined
    response: {
      connected: boolean
      formats: import('@/shared/mediaFormats').MediaFormatsResult
    }
  }
}

export type MessageKind = keyof MessageMap
export type MessageRequest<K extends MessageKind> = MessageMap[K]['request']
export type MessageResponse<K extends MessageKind> = MessageMap[K]['response']

export interface Envelope<K extends MessageKind = MessageKind> {
  kind: K
  payload: MessageRequest<K>
}

export interface ErrorResponse {
  error: string
}

export function isErrorResponse(v: unknown): v is ErrorResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as ErrorResponse).error === 'string'
  )
}
