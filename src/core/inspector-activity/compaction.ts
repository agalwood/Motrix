import {
  type TaskTransferSample,
  TaskTransferSampleFlag,
} from '@shared/types/task-inspector-activity'
import { normalizeTransferSamples } from './validators'

export const MAX_PERSISTED_TASK_SAMPLES = 96
export const COMPACTED_TASK_SAMPLE_COUNT = 72

function coalesceSamples(
  input: readonly TaskTransferSample[]
): TaskTransferSample[] {
  const byTime = new Map<number, TaskTransferSample>()
  for (const point of normalizeTransferSamples(input)) {
    const existing = byTime.get(point.t)
    byTime.set(point.t, {
      ...point,
      flags: (existing?.flags ?? 0) | point.flags,
    })
  }
  return [...byTime.values()].sort((left, right) => left.t - right.t)
}

function peakIndex(
  points: readonly TaskTransferSample[],
  direction: 'down' | 'up'
): number {
  let selected = 0
  for (let index = 1; index < points.length; index += 1) {
    if (points[index][direction] > points[selected][direction]) {
      selected = index
    }
  }
  return selected
}

function triangleContribution(
  left: TaskTransferSample,
  point: TaskTransferSample,
  right: TaskTransferSample,
  direction: 'down' | 'up',
  peak: number
): number {
  if (peak <= 0) return 0
  const leftValue = left[direction] / peak
  const value = point[direction] / peak
  const rightValue = right[direction] / peak
  const leftTime = 0
  const pointTime = point.t - left.t
  const rightTime = right.t - left.t
  return Math.abs(
    leftTime * (value - rightValue) +
      pointTime * (rightValue - leftValue) +
      rightTime * (leftValue - value)
  )
}

/**
 * Deterministic multivariate triangle-area compaction.
 *
 * Summary metrics are intentionally absent: callers persist those separately,
 * so dropping a chart point can never change Average, Peak, or Active.
 */
export function compactTaskTransferSamples(
  input: readonly TaskTransferSample[]
): TaskTransferSample[] {
  const points = coalesceSamples(input)
  if (points.length <= MAX_PERSISTED_TASK_SAMPLES) return points

  const selected = new Set<number>([0, points.length - 1])
  const downloadPeakIndex = peakIndex(points, 'down')
  const uploadPeakIndex = peakIndex(points, 'up')
  selected.add(downloadPeakIndex)
  selected.add(uploadPeakIndex)

  const coverageGapIndex = points.findIndex(
    (point) => (point.flags & TaskTransferSampleFlag.CoverageGap) !== 0
  )
  if (coverageGapIndex >= 0) selected.add(coverageGapIndex)

  const preferNewest = (flag: TaskTransferSampleFlag): void => {
    for (
      let index = points.length - 1;
      index >= 0 && selected.size < COMPACTED_TASK_SAMPLE_COUNT;
      index -= 1
    ) {
      if ((points[index].flags & flag) !== 0) selected.add(index)
    }
  }
  preferNewest(TaskTransferSampleFlag.Terminal)
  preferNewest(TaskTransferSampleFlag.StatusBoundary)

  if (selected.size < COMPACTED_TASK_SAMPLE_COUNT) {
    const downloadPeak = points[downloadPeakIndex].down
    const uploadPeak = points[uploadPeakIndex].up
    const scored: Array<{ index: number; score: number }> = []
    for (let index = 1; index < points.length - 1; index += 1) {
      if (selected.has(index)) continue
      const left = points[index - 1]
      const point = points[index]
      const right = points[index + 1]
      scored.push({
        index,
        score: Math.max(
          triangleContribution(left, point, right, 'down', downloadPeak),
          triangleContribution(left, point, right, 'up', uploadPeak)
        ),
      })
    }
    scored.sort(
      (left, right) =>
        right.score - left.score || points[right.index].t - points[left.index].t
    )
    for (const candidate of scored) {
      if (selected.size >= COMPACTED_TASK_SAMPLE_COUNT) break
      selected.add(candidate.index)
    }
  }

  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => points[index])
}
