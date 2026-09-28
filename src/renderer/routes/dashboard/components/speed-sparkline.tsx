import { useReducedMotion } from '@renderer/lib/reduced-motion'
import { normalizeSpeedHistory } from '@renderer/lib/speed-chart'
import type { SpeedPoint } from '@shared/types/stats'
import { useLayoutEffect, useRef } from 'react'

const WIDTH = 1_000
const HEIGHT = 1_000
const BASELINE = 875
const SCALE_DURATION = 300

interface SpeedSparklineProps {
  history: readonly SpeedPoint[]
  kind: 'up' | 'down'
  ceiling: number
  pointCount: number
}

interface AnimationState extends SpeedSparklineProps {
  startedAt: number
  duration: number
  offset: number
  fromCeiling: number
}

function sampleAnimation(state: AnimationState, now: number) {
  const elapsed = Math.max(0, now - state.startedAt)
  const progress = Math.min(1, elapsed / state.duration)
  const scaleProgress = 1 - (1 - Math.min(1, elapsed / SCALE_DURATION)) ** 3
  return {
    offset: state.offset * (1 - progress),
    ceiling:
      state.fromCeiling + (state.ceiling - state.fromCeiling) * scaleProgress,
    done: progress === 1 && scaleProgress === 1,
  }
}

/** A rolling window with stable vertices; only the drawing moves per frame. */
export function SpeedSparkline({
  history,
  kind,
  ceiling,
  pointCount,
}: SpeedSparklineProps) {
  const reducedMotion = useReducedMotion()
  const groupRef = useRef<SVGGElement>(null)
  const lineRef = useRef<SVGPathElement>(null)
  const fillRef = useRef<SVGPathElement>(null)
  const stateRef = useRef<AnimationState | null>(null)

  useLayoutEffect(() => {
    const group = groupRef.current
    const line = lineRef.current
    const fill = fillRef.current
    if (!group || !line || !fill) return

    const now = performance.now()
    const previous = stateRef.current
    const previousTail = previous?.history.at(-1)
    const tail = history.at(-1)
    const previousIndex = previousTail
      ? history.findLastIndex(
          (point) =>
            point.t === previousTail.t && point[kind] === previousTail[kind]
        )
      : -1
    const added = previousIndex < 0 ? 0 : history.length - previousIndex - 1
    const elapsed = tail && previousTail ? tail.t - previousTail.t : 0
    const canContinue =
      previous &&
      previous.kind === kind &&
      previous.pointCount === pointCount &&
      previousIndex >= 0 &&
      added < pointCount &&
      elapsed >= 0 &&
      elapsed <= 5_000 &&
      !reducedMotion &&
      !document.hidden
    const current = previous ? sampleAnimation(previous, now) : null
    const offset = canContinue ? added + (current?.offset ?? 0) : 0
    // Keep the outgoing vertices until they have crossed the left clip edge.
    const points = normalizeSpeedHistory(
      history.slice(-pointCount - Math.ceil(offset)),
      pointCount + Math.ceil(offset)
    )
    const step = WIDTH / (pointCount - 1)
    const coordinates = points.map((point, index) => {
      const x = WIDTH - (points.length - index - 1) * step
      const y = BASELINE - (point[kind] / ceiling) * BASELINE
      return `${x},${y}`
    })
    const path = `M${coordinates.join('L')}`
    const firstX = WIDTH - (points.length - 1) * step
    line.setAttribute('d', path)
    fill.setAttribute(
      'd',
      `${path}L${WIDTH},${BASELINE}L${firstX},${BASELINE}Z`
    )

    const hasActivity = points.some((point) => point[kind] > 0)
    const state: AnimationState = {
      history,
      kind,
      ceiling,
      pointCount,
      startedAt: now,
      // Match the sampling cadence, with no easing or pause between samples.
      duration: Math.max(
        250,
        Math.min(1_500, added > 0 ? elapsed / added : 1_000)
      ),
      offset: hasActivity ? offset : 0,
      fromCeiling:
        canContinue && hasActivity ? (current?.ceiling ?? ceiling) : ceiling,
    }
    stateRef.current = state
    let frame = 0

    const draw = (timestamp: number) => {
      const sample = sampleAnimation(state, timestamp)
      const scale = ceiling / sample.ceiling
      group.setAttribute(
        'transform',
        `translate(${sample.offset * step} ${BASELINE}) scale(1 ${scale}) translate(0 ${-BASELINE})`
      )
      if (!sample.done && (state.offset > 0 || state.fromCeiling !== ceiling)) {
        frame = requestAnimationFrame(draw)
      }
    }
    const finish = () => {
      cancelAnimationFrame(frame)
      state.offset = 0
      state.fromCeiling = ceiling
      draw(now + Math.max(state.duration, SCALE_DURATION))
    }
    const onVisibilityChange = () => {
      if (document.hidden) finish()
    }

    draw(now)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [history, kind, ceiling, pointCount, reducedMotion])

  const color = `hsl(var(--chart-${kind === 'up' ? 2 : 1}))`

  return (
    <svg
      data-slot="speed-sparkline"
      aria-hidden="true"
      className="h-full w-full overflow-hidden"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
    >
      <rect
        x="0"
        y={BASELINE}
        width={WIDTH}
        height={HEIGHT - BASELINE}
        fill={color}
        fillOpacity={0.12}
      />
      <g ref={groupRef} data-slot="speed-motion">
        <path ref={fillRef} fill={color} fillOpacity={0.12} />
        <path
          ref={lineRef}
          data-slot="speed-curve"
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
  )
}
