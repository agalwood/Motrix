import { TaskStatus, TaskType } from '@shared/types/task'
import { describe, expect, it } from 'vitest'
import { shouldEvictFromEngine } from './should-evict-from-engine'

describe('shouldEvictFromEngine', () => {
  it.each([[TaskType.Bt], [TaskType.Magnet]] as const)(
    'returns true for Seeding -> Completed on %s',
    (type) => {
      expect(
        shouldEvictFromEngine(TaskStatus.Seeding, TaskStatus.Completed, type)
      ).toBe(true)
    }
  )

  it.each([[TaskType.Http], [TaskType.Ftp], [TaskType.Metalink]] as const)(
    'returns false for Seeding -> Completed on %s (non-BT)',
    (type) => {
      expect(
        shouldEvictFromEngine(TaskStatus.Seeding, TaskStatus.Completed, type)
      ).toBe(false)
    }
  )

  it.each([
    [TaskStatus.Downloading, TaskStatus.Completed],
    [TaskStatus.Finalizing, TaskStatus.Seeding],
    [TaskStatus.Seeding, TaskStatus.Paused],
    [TaskStatus.Completed, TaskStatus.Seeding],
    [TaskStatus.Paused, TaskStatus.Completed],
  ] as const)('returns false for %s -> %s on Bt', (before, after) => {
    expect(shouldEvictFromEngine(before, after, TaskType.Bt)).toBe(false)
  })

  // Error is durable history in motrix.db, never a retryable engine state.
  // Leaving the errored row in the engine's persistent session lets the
  // aria2_motrix sqlite store resurrect and auto-retry it on every launch,
  // producing a fresh Error occurrence + notification per boot.
  it.each([
    [TaskType.Http],
    [TaskType.Ftp],
    [TaskType.Bt],
    [TaskType.Magnet],
    [TaskType.Metalink],
  ] as const)('returns true for Downloading -> Error on %s', (type) => {
    expect(
      shouldEvictFromEngine(TaskStatus.Downloading, TaskStatus.Error, type)
    ).toBe(true)
  })

  it.each([
    [TaskStatus.Queued],
    [TaskStatus.Seeding],
    [TaskStatus.FetchingMetadata],
  ] as const)('returns true for %s -> Error on Bt', (before) => {
    expect(shouldEvictFromEngine(before, TaskStatus.Error, TaskType.Bt)).toBe(
      true
    )
  })

  it('returns false for a same-status Error -> Error re-observation', () => {
    expect(
      shouldEvictFromEngine(TaskStatus.Error, TaskStatus.Error, TaskType.Http)
    ).toBe(false)
  })
})
