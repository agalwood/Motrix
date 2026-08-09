import {
  type TaskTransferSample,
  TaskTransferSampleFlag,
} from '@shared/types/task-inspector-activity'
import { describe, expect, it } from 'vitest'
import {
  COMPACTED_TASK_SAMPLE_COUNT,
  compactTaskTransferSamples,
  MAX_PERSISTED_TASK_SAMPLES,
} from './compaction'

function samples(
  count: number,
  map: (index: number) => Partial<TaskTransferSample> = () => ({})
): TaskTransferSample[] {
  return Array.from({ length: count }, (_, index) => ({
    t: index + 1,
    down: index,
    up: count - index,
    flags: 0,
    ...map(index),
  }))
}

describe('task transfer sample compaction', () => {
  it.each([1, 2, MAX_PERSISTED_TASK_SAMPLES])(
    'returns %i unique ordered points without compaction',
    (count) => {
      expect(compactTaskTransferSamples(samples(count))).toEqual(samples(count))
    }
  )

  it.each([97, 1_000])('compacts %i points to exactly 72', (count) => {
    const result = compactTaskTransferSamples(samples(count))
    expect(result).toHaveLength(COMPACTED_TASK_SAMPLE_COUNT)
    expect(result[0]?.t).toBe(1)
    expect(result.at(-1)?.t).toBe(count)
    expect(result.map((point) => point.t)).toEqual(
      [...result.map((point) => point.t)].sort((a, b) => a - b)
    )
  })

  it('coalesces duplicate timestamps with latest speeds and unioned flags', () => {
    expect(
      compactTaskTransferSamples([
        { t: 1, down: 1, up: 2, flags: TaskTransferSampleFlag.StatusBoundary },
        { t: 1, down: 8, up: 9, flags: TaskTransferSampleFlag.Terminal },
      ])
    ).toEqual([
      {
        t: 1,
        down: 8,
        up: 9,
        flags:
          TaskTransferSampleFlag.StatusBoundary |
          TaskTransferSampleFlag.Terminal,
      },
    ])
  })

  it('preserves independent direction peaks and the coverage gap', () => {
    const input = samples(120, (index) => ({
      down: index === 20 ? 10_000 : 1,
      up: index === 90 ? 20_000 : 1,
      flags: index === 55 ? TaskTransferSampleFlag.CoverageGap : 0,
    }))
    const retained = new Set(
      compactTaskTransferSamples(input).map((point) => point.t)
    )
    expect(retained.has(21)).toBe(true)
    expect(retained.has(91)).toBe(true)
    expect(retained.has(56)).toBe(true)
  })

  it('uses independent multivariate area for crossing directions', () => {
    const input = samples(120, (index) => ({
      down: index % 2 === 0 ? 100 : 0,
      up: index % 2 === 0 ? 0 : 100,
    }))
    const result = compactTaskTransferSamples(input)
    expect(result).toHaveLength(COMPACTED_TASK_SAMPLE_COUNT)
    expect(result.some((point) => point.down === 100 && point.up === 0)).toBe(
      true
    )
    expect(result.some((point) => point.down === 0 && point.up === 100)).toBe(
      true
    )
  })

  it('prefers newest terminal points before status boundaries on overflow', () => {
    const input = samples(160, (index) => ({
      down: 0,
      up: 0,
      flags:
        index % 2 === 0
          ? TaskTransferSampleFlag.Terminal
          : TaskTransferSampleFlag.StatusBoundary,
    }))
    const result = compactTaskTransferSamples(input)
    const terminalTimes = result
      .filter((point) => point.flags & TaskTransferSampleFlag.Terminal)
      .map((point) => point.t)
    const boundaryTimes = result
      .filter((point) => point.flags & TaskTransferSampleFlag.StatusBoundary)
      .map((point) => point.t)
    expect(terminalTimes.length).toBeGreaterThan(boundaryTimes.length)
    expect(terminalTimes).toContain(159)
  })

  it('is deterministic for all-zero and one-direction-zero series', () => {
    const zero = samples(200, () => ({ down: 0, up: 0 }))
    const uploadOnly = samples(200, (index) => ({ down: 0, up: index % 7 }))
    expect(compactTaskTransferSamples(zero)).toEqual(
      compactTaskTransferSamples(zero)
    )
    expect(compactTaskTransferSamples(uploadOnly)).toEqual(
      compactTaskTransferSamples(uploadOnly)
    )
  })
})
