import { webBaseUrl, webOriginHeaders } from '@renderer/lib/web-base-url'
import { __webPathPickerBus } from '@renderer/platform/web-services'
import type {
  CreateTorrentRequest,
  CreateTorrentResultPayload,
} from '@shared/schemas/create-torrent'
import {
  saveTorrentFileResultSchema,
  TORRENT_CREATOR_API,
  TORRENT_SEED_HEADER,
  torrentJobSchema,
  torrentJobStatusSchema,
} from '@shared/schemas/create-torrent'
import type { PickedSource, SourceKind } from './creator-sections'

/** One dialog owns one job; closing it also cancels unfinished server work. */
export class ServerTorrentClient {
  private id?: string
  private controller?: AbortController
  private readonly url = webBaseUrl() + TORRENT_CREATOR_API
  async pick(kind: SourceKind) {
    const path = await __webPathPickerBus.request(
      kind === 'file' ? { file: { kind: 'open' } } : { readDirectory: true }
    )
    return path ? { path } : null
  }
  release() {
    this.controller?.abort()
    this.controller = undefined
    if (this.id) this.remove(this.id)
    this.id = undefined
  }
  private remove(id: string) {
    void fetch(`${this.url}/${id}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: webOriginHeaders(),
    }).catch(() => undefined)
  }
  async create(
    source: PickedSource,
    options: CreateTorrentRequest,
    onProgress: (fraction: number) => void
  ) {
    this.release()
    const controller = new AbortController()
    this.controller = controller
    // Receive the id even if the dialog closes during creation so the new job can be discarded.
    const start = await fetch(this.url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { ...webOriginHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ source, options }),
    })
    if (!start.ok) throw new Error('Torrent creation unavailable')
    const { id } = torrentJobSchema.parse(await start.json())
    if (controller.signal.aborted) {
      this.remove(id)
      controller.signal.throwIfAborted()
    }
    this.id = id
    try {
      for (;;) {
        const res = await fetch(`${this.url}/${id}`, {
          signal: controller.signal,
          credentials: 'same-origin',
          headers: webOriginHeaders(),
          cache: 'no-store',
        })
        if (!res.ok) throw new Error('Torrent job expired')
        const state = torrentJobStatusSchema.parse(await res.json())
        if (state.state === 'ready') return state.result
        if (state.state === 'failed') throw new Error('Torrent creation failed')
        onProgress(state.progress)
        await new Promise<void>((resolve) => setTimeout(resolve, 350))
      }
    } catch (error) {
      if (this.id === id) this.release()
      throw error
    }
  }
  async save(result: CreateTorrentResultPayload, seed: boolean) {
    if (this.id !== result.id) throw new Error('Stale torrent')
    const res = await fetch(`${this.url}/${result.id}/export`, {
      method: 'POST',
      signal: this.controller?.signal,
      credentials: 'same-origin',
      headers: { ...webOriginHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ seed }),
    })
    if (!res.ok) throw new Error('Torrent export failed')
    const filename = `${result.name}.torrent`
    const outcome = saveTorrentFileResultSchema.parse({
      path: filename,
      seeding: res.headers.get(TORRENT_SEED_HEADER),
    })
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.append(a)
    try {
      a.click()
    } finally {
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }
    this.release()
    return outcome
  }
}
