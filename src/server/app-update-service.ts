import type { EventBus } from '@core/events/event-bus'
import { isVersionAllowedForChannel } from '@shared/app-update-channel'
import { AppError, ErrorCode } from '@shared/errors'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { Events } from '@shared/protocol/events'
import { compareSemver } from '@shared/semver'
import type { AppUpdateState } from '@shared/types/app-update'
import type { AppUpdateChannel } from '@shared/types/settings'
import { JSON_SCHEMA, load } from 'js-yaml'
import { z } from 'zod'

const MAX_METADATA_BYTES = 256 * 1024
const metadataSchema = z.object({
  version: z.string().max(128),
  releaseName: z.string().max(256).optional(),
})

export async function fetchServerUpdateMetadata(
  channel: AppUpdateChannel,
  signal: AbortSignal
): Promise<unknown> {
  const filename = channel === 'stable' ? 'latest.yml' : 'beta.yml'
  const response = await fetch(
    `${EXTERNAL_URLS.motrix.updateFeed}${filename}`,
    {
      signal,
      redirect: 'error',
      headers: { 'Cache-Control': 'no-cache' },
    }
  )
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Update feed unavailable (${response.status})`)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_METADATA_BYTES)
        throw new Error('Update feed exceeds size limit')
      chunks.push(value)
    }
    return load(Buffer.concat(chunks).toString('utf8'), { schema: JSON_SCHEMA })
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export interface ServerUpdateServiceOptions {
  eventBus: EventBus
  currentVersion: string
  channel: AppUpdateChannel
  loadMetadata?: typeof fetchServerUpdateMetadata
}

/** Checks published versions only; installation belongs to the deployment administrator. */
export class ServerUpdateService {
  private state: AppUpdateState
  private channel: AppUpdateChannel
  private generation = 0
  private pending: Promise<void> | null = null
  private controller: AbortController | null = null

  constructor(private readonly options: ServerUpdateServiceOptions) {
    this.channel = options.channel
    this.state = this.snapshot('idle')
  }

  getState(): AppUpdateState {
    return {
      ...this.state,
      ...(this.state.error ? { error: { ...this.state.error } } : {}),
    }
  }

  setChannel(channel: AppUpdateChannel): void {
    if (channel === this.channel) return
    this.channel = channel
    this.generation++
    this.controller?.abort()
    this.pending = null
    this.transition(this.snapshot('idle'))
  }

  check(): Promise<void> {
    if (this.pending) return this.pending
    const generation = ++this.generation
    const channel = this.channel
    const controller = new AbortController()
    this.controller = controller
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15_000),
    ])
    this.transition(this.snapshot('checking'))
    this.pending = Promise.resolve().then(async () => {
      try {
        const metadata = metadataSchema.parse(
          await (this.options.loadMetadata ?? fetchServerUpdateMetadata)(
            channel,
            signal
          )
        )
        if (generation !== this.generation) return
        if (
          !isVersionAllowedForChannel(metadata.version, channel) ||
          !isVersionAllowedForChannel(this.options.currentVersion, 'beta')
        ) {
          throw new Error('Invalid application update version')
        }
        const available =
          compareSemver(metadata.version, this.options.currentVersion) > 0
        this.transition({
          ...this.snapshot(available ? 'available' : 'up-to-date'),
          checkedAt: new Date().toISOString(),
          ...(available
            ? {
                availableVersion: metadata.version,
                releaseName: metadata.releaseName,
              }
            : {}),
        })
      } catch {
        if (generation !== this.generation) return
        const message = 'settings.about.update.errorDescription'
        this.transition({ ...this.snapshot('error'), error: { message } })
        throw new AppError(ErrorCode.AppUpdateCheckFailed, message)
      } finally {
        if (generation === this.generation) {
          this.pending = null
          this.controller = null
        }
      }
    })
    return this.pending
  }

  private snapshot(phase: AppUpdateState['phase']): AppUpdateState {
    return {
      phase,
      currentVersion: this.options.currentVersion,
      updateAuthority: 'administrator',
    }
  }

  private transition(state: AppUpdateState): void {
    this.state = state
    this.options.eventBus.emit(Events.UpdateStateChanged, this.getState())
  }
}
