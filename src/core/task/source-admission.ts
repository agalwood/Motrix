import { AppError, ErrorCode } from '@shared/errors'
import { analyzeDownloadSource } from '@shared/lib/download-source'
import { taskCreateRequestSchema } from '@shared/schemas/add-task'
import {
  type AcceptedDownloadSource,
  MAX_MIRROR_URIS,
  type SourceFailure,
  type SourceProtocol,
} from '@shared/schemas/download-source'

export class DownloadSourceError extends AppError {
  constructor(public readonly details: SourceFailure) {
    super(
      ErrorCode.TaskSourceInvalid,
      `task.add.sourceErrors.${details.diagnostic.reason}`
    )
  }
}

export function admitDownloadSources(
  uris: readonly string[],
  stage: SourceFailure['stage'] = 'input',
  protocols: readonly SourceProtocol[] = ['http', 'https', 'ftp', 'magnet']
): AcceptedDownloadSource[] {
  if (uris.length === 0 || uris.length > MAX_MIRROR_URIS)
    throw new DownloadSourceError({
      stage,
      index: 0,
      diagnostic: { reason: 'tooManySources', start: 0, end: 0 },
    })
  const sources = uris.map((uri, index) => {
    const result = analyzeDownloadSource(uri, protocols)
    if (result.status !== 'accepted')
      throw new DownloadSourceError({
        stage,
        index,
        diagnostic: result.diagnostic,
      })
    return result
  })
  const family = (source: AcceptedDownloadSource) =>
    source.protocol === 'https' ? 'http' : source.protocol
  if (
    sources.some((source) => family(source) !== family(sources[0])) ||
    (sources[0].protocol === 'magnet' && sources.length !== 1)
  )
    throw new DownloadSourceError({
      stage,
      index: 0,
      diagnostic: { reason: 'mixedProtocols', start: 0, end: 0 },
    })
  return sources
}

export function admitHttpSource(
  uri: string,
  stage: SourceFailure['stage'] = 'resolution'
): string {
  return admitDownloadSources([uri], stage, ['http', 'https'])[0].requestUrl
}

export function taskCreateSourceFailure(error: unknown) {
  return error instanceof DownloadSourceError
    ? { outcome: 'invalid-source' as const, failure: error.details }
    : null
}

/** Run before plugin activation, engine readiness, and save-directory preparation. */
export function admitTaskCreateRequest(raw: unknown) {
  const parsed = taskCreateRequestSchema.safeParse(raw)
  if (!parsed.success)
    throw new AppError(
      ErrorCode.IpcInvalidPayload,
      'Invalid task create request'
    )
  const req = parsed.data
  if (req.type === 'http') {
    req.uris = admitDownloadSources(req.uris, 'input', [
      'http',
      'https',
      'ftp',
    ]).map((source) => source.sourceUrl)
    if (req.uris[0].startsWith('ftp:') && req.headers.length > 0)
      throw new DownloadSourceError({
        stage: 'input',
        index: 0,
        diagnostic: { reason: 'unsupportedRequestOptions', start: 0, end: 0 },
      })
  } else if (req.payload.kind === 'magnet') {
    req.payload.uri = admitDownloadSources([req.payload.uri], 'input', [
      'magnet',
    ])[0].sourceUrl
  }
  return req
}
