import { randomUUID } from 'node:crypto'
import { Events } from '@shared/protocol/events'
import type { RendererCapability } from '@shared/schemas/renderer-health'
import {
  type RendererIntentChannel,
  rendererIntentChannelSchema,
} from '@shared/schemas/renderer-intent'
import type { WindowId } from '@shared/types/window'
import type { BrowserWindow, WebContents } from 'electron'

interface Intent {
  id: string
  channel: RendererIntentChannel
  payload: () => unknown
  generation?: string
}
interface IntentDeps {
  window(id: WindowId): BrowserWindow | null
  session(sender: WebContents): { generation: string }
  ready(id: WindowId, capability: RendererCapability): boolean
}

/** Coalesces navigation and retains the latest add-task descriptor across documents. */
export class RendererIntents {
  private readonly pending = new Map<WindowId, Map<string, Intent>>()
  constructor(private readonly deps: IntentDeps) {}

  deliver(
    id: WindowId,
    channel: string,
    payload: unknown,
    resolve?: () => unknown
  ): boolean {
    const parsed = rendererIntentChannelSchema.safeParse(channel)
    if (!parsed.success) return false
    // Only bounded URL/form descriptors may be copied into the queue.
    if (
      !resolve &&
      new TextEncoder().encode(JSON.stringify(payload ?? null)).length >
        256 * 1024
    )
      return true
    let bucket = this.pending.get(id)
    if (!bucket) {
      bucket = new Map()
      this.pending.set(id, bucket)
    }
    // Form mode changes supersede one another; totals are a separate snapshot.
    const key =
      channel === Events.NavigateTo
        ? 'navigation'
        : channel === Events.TorrentQueueSizeChanged
          ? 'total'
          : 'form'
    bucket.set(key, {
      id: randomUUID(),
      channel: parsed.data,
      payload: resolve ?? (() => payload),
    })
    this.flush(id)
    return true
  }

  flush(id: WindowId): void {
    const win = this.deps.window(id)
    if (!win || win.isDestroyed()) return
    const capability = id === 'main' ? 'navigation' : 'add-task-hydration'
    if (!this.deps.ready(id, capability)) return
    const { generation } = this.deps.session(win.webContents)
    for (const intent of this.pending.get(id)?.values() ?? []) {
      if (intent.generation === generation) continue
      const payload = intent.payload()
      if (payload === undefined) continue
      intent.generation = generation
      try {
        win.webContents.send(Events.RendererIntent, {
          id: intent.id,
          generation,
          channel: intent.channel,
          payload,
        })
      } catch {
        intent.generation = undefined
      }
    }
  }

  acknowledge(id: WindowId, generation: string, intentId: string): void {
    const bucket = this.pending.get(id)
    for (const [key, intent] of bucket ?? []) {
      if (
        intent.id === intentId &&
        intent.generation === generation &&
        id === 'main'
      )
        bucket?.delete(key)
    }
  }

  clear(id: WindowId): void {
    this.pending.delete(id)
  }
}
