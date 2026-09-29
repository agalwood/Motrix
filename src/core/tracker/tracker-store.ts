import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  TRACKER_HEALTH_MAX_AGE_MS,
  TRACKER_HISTORY_MAX_AGE_MS,
  trackerStateSchema,
} from '@shared/schemas/tracker-state'
import type { CuratedTrackerList, TrackerHealth } from '@shared/types/tracker'
import writeFileAtomic from 'write-file-atomic'

export class TrackerStore {
  private backupSuffix: string | null = null
  private writes: Promise<void> = Promise.resolve()
  constructor(private filePath: string) {}

  async load(): Promise<CuratedTrackerList> {
    try {
      const parsed = trackerStateSchema.parse(
        JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
      )
      this.backupSuffix = parsed.version !== 2 ? 'v1.bak' : null
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.backupSuffix = 'invalid.bak'
      return trackerStateSchema.parse({})
    }
  }

  save(list: CuratedTrackerList): Promise<void> {
    const snapshot = JSON.stringify({ ...list, version: 2 }, null, 2)
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true })
        if (this.backupSuffix) {
          try {
            await fs.copyFile(
              this.filePath,
              `${this.filePath}.${this.backupSuffix}`,
              constants.COPYFILE_EXCL
            )
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            if (this.backupSuffix === 'invalid.bak') {
              await fs.copyFile(
                this.filePath,
                `${this.filePath}.${randomUUID()}.invalid.bak`,
                constants.COPYFILE_EXCL
              )
            }
          }
          this.backupSuffix = null
        }
        await writeFileAtomic(this.filePath, snapshot)
      })
    this.writes = write
    return write
  }

  flush(): Promise<void> {
    return this.writes
  }

  mergeHealth(
    existing: Record<string, TrackerHealth>,
    fresh: TrackerHealth[]
  ): Record<string, TrackerHealth> {
    const result = { ...existing }
    for (const item of fresh) {
      const prev = result[item.url]
      const now = item.lastProbeAt ?? Date.now()
      const compatible = prev?.routeKey === item.routeKey
      const samples = (compatible ? (prev?.samples ?? []) : []).filter(
        (sample) => now - sample.at <= TRACKER_HEALTH_MAX_AGE_MS
      )
      if (item.status !== 'unknown')
        samples.push({ at: now, ok: item.status !== 'unreachable' })
      const recent = samples.slice(-20)
      const successCount = recent.filter((sample) => sample.ok).length
      const failCount = recent.length - successCount
      result[item.url] = {
        ...item,
        samples: recent,
        successCount,
        failCount,
        successRate: recent.length ? successCount / recent.length : 0,
      }
    }
    return result
  }
}

export function pruneTrackerHealth(
  health: Record<string, TrackerHealth>,
  referenced: Set<string>,
  now: number
): Record<string, TrackerHealth> {
  const archived = Object.entries(health)
    .filter(
      ([url, record]) =>
        !referenced.has(url) &&
        record.lastProbeAt != null &&
        now - record.lastProbeAt <= TRACKER_HISTORY_MAX_AGE_MS
    )
    .sort((a, b) => (b[1].lastProbeAt ?? 0) - (a[1].lastProbeAt ?? 0))
    .slice(0, 5000)
  return Object.fromEntries([
    ...archived,
    ...Object.entries(health).filter(([url]) => referenced.has(url)),
  ])
}
