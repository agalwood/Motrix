import { TaskStatus } from '@shared/types/task'
import { describe, expect, it } from 'vitest'
import { shouldTriggerTransitionSave } from './should-trigger-transition-save'

describe('shouldTriggerTransitionSave', () => {
  it.each([
    // Capture-before-zeroing: aria2 nukes mirror fields after these.
    [TaskStatus.Downloading, TaskStatus.Paused],
    [TaskStatus.Downloading, TaskStatus.Error],
    [TaskStatus.FetchingMetadata, TaskStatus.Error],
    // Identity-defining: first time the task becomes active.
    [TaskStatus.Queued, TaskStatus.Downloading],
    [TaskStatus.FetchingMetadata, TaskStatus.Downloading],
  ] as const)('returns true for %s -> %s', (before, after) => {
    expect(shouldTriggerTransitionSave(before, after)).toBe(true)
  })

  it.each(
    Object.values(TaskStatus)
      .filter(
        (status) =>
          status !== TaskStatus.Completed && status !== TaskStatus.Error
      )
      .flatMap((status) => [
        [status, TaskStatus.Completed] as const,
        [status, TaskStatus.Error] as const,
      ])
  )('durably saves every non-terminal %s -> %s', (before, after) => {
    expect(shouldTriggerTransitionSave(before, after)).toBe(true)
  })

  it.each([
    // Reverse direction — only the listed direction triggers a save.
    [TaskStatus.Paused, TaskStatus.Downloading],
    [TaskStatus.Downloading, TaskStatus.Queued],
    // Same-status (no transition).
    [TaskStatus.Paused, TaskStatus.Paused],
    [TaskStatus.Downloading, TaskStatus.Downloading],
    // Pre-active states that don't yet matter for crash recovery.
    [TaskStatus.Queued, TaskStatus.FetchingMetadata],
    [TaskStatus.Queued, TaskStatus.Paused],
    [TaskStatus.Seeding, TaskStatus.Paused],
  ] as const)('returns false for %s -> %s', (before, after) => {
    expect(shouldTriggerTransitionSave(before, after)).toBe(false)
  })
})
