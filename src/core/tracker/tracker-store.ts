import fs from 'node:fs/promises'
import type { CuratedTrackerList, TrackerHealth } from '@shared/types/tracker'
import writeFileAtomic from 'write-file-atomic'

const EMPTY_LIST: CuratedTrackerList = {
  effective: [],
  blacklist: [],
  healthMap: {},
  sourceMap: {},
  lastSyncAt: null,
  lastProbeAt: null,
}

export class TrackerStore {
  constructor(private filePath: string) {}

  async load(): Promise<CuratedTrackerList> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<CuratedTrackerList>
      return {
        effective: parsed.effective ?? [],
        blacklist: parsed.blacklist ?? [],
        healthMap: parsed.healthMap ?? {},
        sourceMap: parsed.sourceMap ?? {},
        lastSyncAt: parsed.lastSyncAt ?? null,
        lastProbeAt: parsed.lastProbeAt ?? null,
      }
    } catch {
      return { ...EMPTY_LIST, healthMap: {}, sourceMap: {} }
    }
  }

  async save(list: CuratedTrackerList): Promise<void> {
    const dir = this.filePath.replace(/[/\\][^/\\]+$/, '')
    await fs.mkdir(dir, { recursive: true })
    // Atomic: tracker.json accumulates health stats over time.
    // A half-written file on crash would silently reset the
    // cumulative successCount / failCount / sourceMap.
    await writeFileAtomic(this.filePath, JSON.stringify(list, null, 2))
  }

  mergeHealth(
    existing: Record<string, TrackerHealth>,
    fresh: TrackerHealth[]
  ): Record<string, TrackerHealth> {
    const result = { ...existing }
    for (const item of fresh) {
      const prev = result[item.url]
      if (prev) {
        const successCount = prev.successCount + item.successCount
        const failCount = prev.failCount + item.failCount
        const total = successCount + failCount
        result[item.url] = {
          ...item,
          successCount,
          failCount,
          successRate: total > 0 ? successCount / total : 0,
        }
      } else {
        result[item.url] = item
      }
    }
    return result
  }
}
