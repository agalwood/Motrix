import fs from 'node:fs/promises'
import path from 'node:path'
import type { SegmentFileProgress } from '@core/download/segment-downloader'
import { getLogger } from '@core/logger'
import type { SegmentPlan } from '@core/media/segment-plan'
import type { TaskFile } from '@shared/types/task'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import {
  createMediaTaskFiles,
  mediaFileSchema,
  toMediaTaskFiles,
  updateMediaTaskFile,
} from './media-task-files'

const log = getLogger('MediaMetaStore')
const CHECKPOINT_MS = 15_000
const metadataSchema = z.object({
  version: z.literal(1),
  video: z.array(mediaFileSchema),
  audio: z.array(mediaFileSchema),
  manifests: z.array(z.object({ file: z.string(), url: z.string() })),
})

export interface MediaManifest {
  name: 'master.m3u8' | 'video.m3u8' | 'audio.m3u8' | 'manifest.mpd'
  url: string
  text: string
}

export interface MediaMetadataInput {
  video: SegmentPlan
  audio?: SegmentPlan
  manifests?: MediaManifest[]
}

export interface MediaMetaStore {
  persist(taskId: string, input: MediaMetadataInput): Promise<string>
  read(metaPath: string): Promise<TaskFile[] | null>
  update(
    metaPath: string,
    stream: 'video' | 'audio',
    progress: SegmentFileProgress
  ): void
  release(metaPath: string): Promise<void>
  remove(metaPath: string): Promise<void>
}

interface ActiveMetadata {
  data: z.infer<typeof metadataSchema>
  pending: Promise<void>
  writing: boolean
  revision: number
  savedRevision: number
  timer?: ReturnType<typeof setTimeout>
  releasing: boolean
}

/** Central application metadata, independent of the user's output directory.
 * Only the returned path belongs in SQLite. Active progress is kept in memory
 * and checkpointed at most once per interval, plus once when the run settles.
 */
export class MediaMetaStoreImpl implements MediaMetaStore {
  private readonly active = new Map<string, ActiveMetadata>()

  constructor(private readonly baseDir: string) {}

  async persist(taskId: string, input: MediaMetadataInput): Promise<string> {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId))
      throw new Error('Invalid media task id')
    const dir = path.resolve(this.baseDir, taskId)
    const metaPath = path.join(dir, 'files.json')
    const data: ActiveMetadata['data'] = {
      version: 1,
      video: createMediaTaskFiles(input.video, 'video'),
      audio: input.audio ? createMediaTaskFiles(input.audio, 'audio') : [],
      manifests: (input.manifests ?? []).map(({ name, url }) => ({
        file: name,
        url,
      })),
    }
    // Task ids are unique. Refuse to overwrite an existing task's metadata.
    await fs.mkdir(this.baseDir, { recursive: true })
    await fs.mkdir(dir, { mode: 0o700 })
    try {
      for (const manifest of input.manifests ?? []) {
        await writeFileAtomic(path.join(dir, manifest.name), manifest.text, {
          mode: 0o600,
        })
      }
      await writeFileAtomic(metaPath, JSON.stringify(data), { mode: 0o600 })
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    this.active.set(metaPath, {
      data,
      pending: Promise.resolve(),
      writing: false,
      revision: 0,
      savedRevision: 0,
      releasing: false,
    })
    return metaPath
  }

  async read(metaPath: string): Promise<TaskFile[] | null> {
    if (!this.owns(metaPath)) return null
    metaPath = path.resolve(metaPath)
    const entry = this.active.get(metaPath)
    if (entry)
      return toMediaTaskFiles([...entry.data.video, ...entry.data.audio])
    try {
      const data = metadataSchema.parse(
        JSON.parse(await fs.readFile(metaPath, 'utf8'))
      )
      return toMediaTaskFiles([...data.video, ...data.audio])
    } catch (error) {
      log.warn({ err: error, metaPath }, 'Media metadata unavailable')
      return null
    }
  }

  update(
    metaPath: string,
    stream: 'video' | 'audio',
    progress: SegmentFileProgress
  ): void {
    metaPath = path.resolve(metaPath)
    const entry = this.active.get(metaPath)
    if (!entry || entry.releasing) return
    updateMediaTaskFile(entry.data[stream], progress)
    entry.revision++
    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = undefined
        void this.checkpoint(metaPath, entry).catch((err) => {
          log.warn({ err, metaPath }, 'Media progress checkpoint failed')
        })
      }, CHECKPOINT_MS)
      entry.timer.unref?.()
    }
  }

  async release(metaPath: string): Promise<void> {
    metaPath = path.resolve(metaPath)
    const entry = this.active.get(metaPath)
    if (!entry) return
    if (entry.releasing) return entry.pending
    entry.releasing = true
    clearTimeout(entry.timer)
    try {
      await this.checkpoint(metaPath, entry)
    } catch (error) {
      // The coordinator retries release in its finalizer. Keep the latest
      // progress readable until that retry instead of falling back to stale IO.
      entry.releasing = false
      entry.timer = undefined
      throw error
    }
    if (this.active.get(metaPath) === entry) this.active.delete(metaPath)
  }

  async remove(metaPath: string): Promise<void> {
    if (!this.owns(metaPath)) throw new Error('Invalid media metadata path')
    metaPath = path.resolve(metaPath)
    const entry = this.active.get(metaPath)
    // Detach before awaiting IO: late progress/release cannot recreate files.
    this.active.delete(metaPath)
    if (entry) {
      clearTimeout(entry.timer)
      await entry.pending.catch(() => {})
    }
    await fs.rm(path.dirname(metaPath), { recursive: true, force: true })
  }

  /** Run at startup, before admitting submissions. Use durable DB ids rather
   * than restored in-memory tasks: engine recovery may omit a persisted task.
   * Recovers crashes between metadata creation/task insertion or task deletion/
   * metadata cleanup, including cleanup that previously failed on the OS.
   */
  async pruneOrphans(retainedTaskIds: readonly string[]): Promise<void> {
    const retained = new Set(retainedTaskIds)
    let entries: string[]
    try {
      entries = await fs.readdir(this.baseDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const id of entries) {
      if (retained.has(id) || !/^[a-zA-Z0-9_-]+$/.test(id)) continue
      const metaPath = path.resolve(this.baseDir, id, 'files.json')
      if (this.active.has(metaPath)) continue
      try {
        // Never follow a directory link while collecting metadata.
        if (!(await fs.lstat(path.dirname(metaPath))).isDirectory()) continue
        await this.remove(metaPath)
      } catch (err) {
        log.warn({ err, metaPath }, 'Orphan media metadata cleanup failed')
      }
    }
  }

  private checkpoint(metaPath: string, entry: ActiveMetadata): Promise<void> {
    if (entry.writing) return entry.pending
    if (entry.savedRevision === entry.revision) return Promise.resolve()
    entry.writing = true
    // At most one write plus the latest in-memory state. Never queue a full
    // serialized snapshot every 15s while a slow filesystem is still busy.
    entry.pending = (async () => {
      do {
        const revision = entry.revision
        await writeFileAtomic(metaPath, JSON.stringify(entry.data), {
          mode: 0o600,
        })
        entry.savedRevision = revision
      } while (
        this.active.get(metaPath) === entry &&
        entry.savedRevision !== entry.revision
      )
    })().finally(() => {
      entry.writing = false
    })
    return entry.pending
  }

  private owns(metaPath: string): boolean {
    const relative = path.relative(
      path.resolve(this.baseDir),
      path.resolve(metaPath)
    )
    const parts = relative.split(path.sep)
    return (
      parts.length === 2 &&
      /^[a-zA-Z0-9_-]+$/.test(parts[0]) &&
      parts[1] === 'files.json'
    )
  }
}
