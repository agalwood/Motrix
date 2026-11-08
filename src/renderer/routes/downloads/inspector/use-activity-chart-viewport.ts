import { useState } from 'react'
import type {
  ActivityChartDomain,
  ActivityChartRange,
} from './activity-chart-model'

export const RECENT_ACTIVITY_MS = 60_000
export const MIN_ACTIVITY_WINDOW_MS = 1_000

export function activityChartBounds(
  domain: ActivityChartDomain | null,
  range: ActivityChartRange = 'session'
): ActivityChartDomain {
  const [start, end] = domain ?? [0, RECENT_ACTIVITY_MS]
  const minimumSpan =
    range === 'session' ? RECENT_ACTIVITY_MS : MIN_ACTIVITY_WINDOW_MS
  return [Math.min(start, end - minimumSpan), end]
}

export function clampActivityWindow(
  requested: ActivityChartDomain,
  bounds: ActivityChartDomain
): ActivityChartDomain {
  const duration = Math.min(
    bounds[1] - bounds[0],
    Math.max(MIN_ACTIVITY_WINDOW_MS, requested[1] - requested[0])
  )
  const start = Math.max(
    bounds[0],
    Math.min(requested[0], bounds[1] - duration)
  )
  return [start, start + duration]
}

interface Selection {
  range: ActivityChartRange
  window: ActivityChartDomain | null
  following: boolean
  all: boolean
}

function initialSelection(range: ActivityChartRange): Selection {
  return { range, window: null, following: true, all: range === 'lifetime' }
}

export function useActivityChartViewport(
  domain: ActivityChartDomain | null,
  range: ActivityChartRange,
  onInteraction?: () => void
) {
  const [selection, setSelection] = useState(() => initialSelection(range))
  const active = selection.range === range ? selection : initialSelection(range)
  if (selection.range !== range) setSelection(active)

  const bounds = activityChartBounds(domain, range)
  const duration = active.window
    ? active.window[1] - active.window[0]
    : RECENT_ACTIVITY_MS
  const window = active.all
    ? bounds
    : clampActivityWindow(
        active.following
          ? [bounds[1] - duration, bounds[1]]
          : (active.window ?? bounds),
        bounds
      )

  function select(requested: ActivityChartDomain) {
    onInteraction?.()
    const next = clampActivityWindow(requested, bounds)
    const following = bounds[1] - next[1] <= 1
    setSelection({
      range,
      window: next,
      following,
      all: range === 'lifetime' && following && next[0] <= bounds[0] + 1,
    })
  }

  function zoom(factor: number) {
    const nextDuration = Math.min(
      bounds[1] - bounds[0],
      Math.max(MIN_ACTIVITY_WINDOW_MS, (window[1] - window[0]) * factor)
    )
    const start = active.following
      ? window[1] - nextDuration
      : (window[0] + window[1] - nextDuration) / 2
    select([start, start + nextDuration])
  }

  return {
    bounds,
    window,
    following: active.following,
    select,
    pan: (delta: number) => select([window[0] + delta, window[1] + delta]),
    zoom,
    showAll: () => {
      onInteraction?.()
      setSelection({ range, window: null, following: true, all: true })
    },
    followLatest: () => {
      onInteraction?.()
      setSelection({ ...active, range, following: true })
    },
  }
}
