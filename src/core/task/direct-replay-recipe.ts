import type { CreateDownloadParams } from '@core/engine/engine-adapter'
import type {
  DirectReplayRecipe,
  DirectReplayRequestModifier,
} from '@shared/schemas/direct-replay-recipe'

export type { DirectReplayRecipe } from '@shared/schemas/direct-replay-recipe'

/**
 * Build the durable, non-sensitive replay capability record for a direct
 * download. The output intentionally contains neither paths/URIs (already
 * canonical on TaskInstance) nor any request-modifier values.
 */
export function buildDirectReplayRecipe(
  params: Pick<
    CreateDownloadParams,
    'connections' | 'headers' | 'proxy' | 'extraEngineOptions'
  >,
  ambientEngineRequestOptions = false
): DirectReplayRecipe {
  const requestModifiers: DirectReplayRequestModifier[] = []

  if (hasEntries(params.headers)) requestModifiers.push('headers')
  if (hasText(params.proxy)) requestModifiers.push('proxy')
  if (hasEntries(params.extraEngineOptions)) {
    requestModifiers.push('extraEngineOptions')
  }
  if (ambientEngineRequestOptions) {
    requestModifiers.push('engineGlobalOptions')
  }

  return {
    version: 1,
    ...(params.connections === undefined
      ? {}
      : { connections: params.connections }),
    requestModifiers,
    replayability:
      requestModifiers.length === 0 ? 'uri-only' : 'requires-credentials',
  }
}

function hasEntries(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0
}

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0
}
