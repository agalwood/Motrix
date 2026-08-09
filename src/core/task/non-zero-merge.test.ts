import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import { nonZeroMerge } from './non-zero-merge'

const baseTask = (over: Partial<DownloadTask> = {}): DownloadTask =>
  makeDownloadTask({ id: 't1', engineTaskId: 'gid1', name: 'a', ...over })

describe('nonZeroMerge', () => {
  it('preserves non-zero totalBytes when incoming is zero', () => {
    const existing = baseTask({ totalBytes: 1024 })
    const incoming = baseTask({ totalBytes: 0 })
    expect(nonZeroMerge(existing, incoming).totalBytes).toBe(1024)
  })

  it('overwrites totalBytes when incoming is non-zero', () => {
    const existing = baseTask({ totalBytes: 1024 })
    const incoming = baseTask({ totalBytes: 2048 })
    expect(nonZeroMerge(existing, incoming).totalBytes).toBe(2048)
  })

  it.each(['downloadedBytes', 'sizeWhenDone', 'fileCount'] as const)(
    'preserves non-zero %s when incoming is zero',
    (field) => {
      const existing = baseTask({ [field]: 42 })
      const incoming = baseTask({ [field]: 0 })
      expect(nonZeroMerge(existing, incoming)[field]).toBe(42)
    }
  )

  // uploadedBytes is intentionally NOT a mirror field anymore: it is
  // derived in mergeEngineTask as `existing.uploadedBytesBaseline +
  // incoming.uploadedBytes` (the latter being the current gid's
  // uploadLength). nonZeroMerge passes incoming.uploadedBytes through
  // as-is — clobbering would defeat baseline accumulation.
  it('passes uploadedBytes through unchanged (handled by mergeEngineTask)', () => {
    const existing = baseTask({ uploadedBytes: 42 })
    const incoming = baseTask({ uploadedBytes: 0 })
    expect(nonZeroMerge(existing, incoming).uploadedBytes).toBe(0)
  })

  it('always overwrites status (paused is a valid transition)', () => {
    const existing = baseTask({ status: TaskStatus.Downloading })
    const incoming = baseTask({ status: TaskStatus.Paused })
    expect(nonZeroMerge(existing, incoming).status).toBe(TaskStatus.Paused)
  })

  it('always overwrites speed/eta/connections (zero is correct for paused)', () => {
    const existing = baseTask({
      downloadSpeed: 1000,
      uploadSpeed: 500,
      etaSeconds: 60,
      connections: 4,
    })
    const incoming = baseTask({
      downloadSpeed: 0,
      uploadSpeed: 0,
      etaSeconds: 0,
      connections: 0,
    })
    const merged = nonZeroMerge(existing, incoming)
    expect(merged.downloadSpeed).toBe(0)
    expect(merged.uploadSpeed).toBe(0)
    expect(merged.etaSeconds).toBe(0)
    expect(merged.connections).toBe(0)
  })
})
