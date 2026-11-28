import type { CreateDownloadParams } from '@core/engine/engine-adapter'
import type {
  DirectReplayRecipe,
  DirectReplayRequestModifier,
} from '@shared/schemas/direct-replay-recipe'
import { parseDirectReplayRecipe } from '@shared/schemas/direct-replay-recipe'

export type { DirectReplayRecipe } from '@shared/schemas/direct-replay-recipe'

/**
 * Build the durable, non-sensitive replay capability record for a direct
 * download. The output intentionally contains neither paths/URIs (already
 * canonical on TaskInstance) nor any request-modifier values.
 */
export function buildDirectReplayRecipe(
  params: Pick<
    CreateDownloadParams,
    | 'connections'
    | 'headers'
    | 'cookies'
    | 'proxy'
    | 'extraEngineOptions'
    | 'retainRequestContext'
  >,
  ambientEngineRequestOptions = false
): DirectReplayRecipe {
  const requestModifiers: DirectReplayRequestModifier[] = []

  if (hasEntries(params.headers)) requestModifiers.push('headers')
  if (params.cookies !== undefined) requestModifiers.push('cookies')
  if (hasText(params.proxy)) requestModifiers.push('proxy')
  if (hasEntries(params.extraEngineOptions)) {
    requestModifiers.push('extraEngineOptions')
  }
  if (ambientEngineRequestOptions) {
    requestModifiers.push('engineGlobalOptions')
  }

  return {
    version: 1,
    ...(params.retainRequestContext
      ? { engineContextVersion: 1 as const }
      : {}),
    ...(params.connections === undefined
      ? {}
      : { connections: params.connections }),
    requestModifiers,
    replayability:
      requestModifiers.length === 0 ? 'uri-only' : 'requires-credentials',
  }
}

/** Recompute the retention intent whenever a replacement request is created. */
export function updateDirectReplayRetention(
  payload: Record<string, unknown>,
  retain: boolean
): Record<string, unknown> {
  const recipe = parseDirectReplayRecipe(payload)
  if (!recipe) return payload
  const updated = { ...recipe }
  delete updated.engineContextVersion
  if (retain) updated.engineContextVersion = 1
  return { ...payload, directReplay: updated }
}

function hasEntries(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0
}

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0
}
