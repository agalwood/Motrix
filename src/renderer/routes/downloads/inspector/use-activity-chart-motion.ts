import { useReducedMotion } from '@renderer/lib/reduced-motion'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AnimationInterpolateFn, AreaPointItem } from 'recharts'
import type { ActivityChartRange } from './activity-chart-model'

/** Match the Dashboard sparkline: linear time travel and a 300ms scale settle. */
export function interpolateActivitySamples(
  duration: number
): AnimationInterpolateFn<AreaPointItem, 'horizontal' | 'vertical'> {
  return (items, progress) => {
    if (!items) return []
    const matched = items.findLast((item) => item.status === 'matched')
    const offset =
      matched?.status === 'matched' &&
      matched.prev.x !== null &&
      matched.next.x !== null
        ? matched.prev.x - matched.next.x
        : 0
    const scaleProgress =
      1 - (1 - Math.min(1, (progress * duration) / 300)) ** 3
    return items.flatMap((item) => {
      if (item.status === 'removed') return []
      const next = item.next
      if (progress === 1) return [next]
      const x =
        next.x === null
          ? null
          : item.status === 'matched' && item.prev.x !== null
            ? item.prev.x + (next.x - item.prev.x) * progress
            : next.x + offset * (1 - progress)
      // Null is missing data, never a numerical zero during interpolation.
      const y =
        item.status === 'matched' &&
        typeof next.y === 'number' &&
        typeof item.prev.y === 'number'
          ? item.prev.y + (next.y - item.prev.y) * scaleProgress
          : next.y
      return [{ ...next, x, y }]
    })
  }
}

export function useActivityChartMotion(
  time: number | undefined,
  range: ActivityChartRange,
  following: boolean
) {
  const reducedMotion = useReducedMotion()
  const [visible, setVisible] = useState(() => !document.hidden)
  const previous = useRef<{
    time: number | undefined
    range: ActivityChartRange
    following: boolean
  } | null>(null)
  const delta =
    time !== undefined && previous.current?.time !== undefined
      ? time - previous.current.time
      : 0
  const duration = Math.max(250, Math.min(1500, delta))
  const active =
    visible &&
    !reducedMotion &&
    following &&
    previous.current?.following === true &&
    previous.current.range === range &&
    delta > 0 &&
    delta <= 5000
  const interpolate = useMemo(
    () => interpolateActivitySamples(duration),
    [duration]
  )

  useLayoutEffect(() => {
    previous.current = { time, range, following }
  }, [time, range, following])
  useEffect(() => {
    const onVisibilityChange = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () =>
      document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])
  return { active, duration, interpolate }
}
