import { randomUUID } from 'node:crypto'
import { Events } from '@shared/protocol/events'
import { magnetFileSelectionPayloadSchema } from '@shared/schemas/add-task'
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
  magnetTaskId?: string
}
interface IntentDeps {
  window(id: WindowId): BrowserWindow | null
  session(sender: WebContents): { generation: string }
  ready(id: WindowId, capability: RendererCapability): boolean
  isMagnetSelectionPending(taskId: string): boolean
}

const magnetSelectionIdentitySchema = magnetFileSelectionPayloadSchema.pick({
  taskId: true,
})

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
    let magnetTaskId: string | undefined
    if (channel === Events.MagnetFileSelection) {
      const selection = magnetSelectionIdentitySchema.safeParse(payload)
      if (!selection.success) return true
      magnetTaskId = selection.data.taskId
      if (!this.deps.isMagnetSelectionPending(magnetTaskId)) return true
    }
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
      magnetTaskId,
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
    const bucket = this.pending.get(id)
    for (const [key, intent] of bucket ?? []) {
      // Background timeout, another client or removal can settle the task
      // without a live renderer to receive the corresponding event.
      if (
        intent.magnetTaskId &&
        !this.deps.isMagnetSelectionPending(intent.magnetTaskId)
      ) {
        bucket?.delete(key)
        continue
      }
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

  settleMagnetSelection(taskId: string): void {
    const bucket = this.pending.get('add-task')
    if (bucket?.get('form')?.magnetTaskId === taskId) bucket.delete('form')
  }
}
