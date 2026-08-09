import type { RefObject } from 'react'
import { useCallback, useRef } from 'react'

const FRAME_DURATION_MS = 1000 / 60

interface UseAutoScrollOptions {
  containerRef: RefObject<HTMLDivElement | null>
  gutter: number
  maxSpeed: number
  enabled: boolean
}

export function useAutoScroll(options: UseAutoScrollOptions) {
  const { containerRef, gutter, maxSpeed, enabled } = options
  const speedRef = useRef(0)
  const previousTimestampRef = useRef<number | null>(null)

  const stop = useCallback(() => {
    speedRef.current = 0
    previousTimestampRef.current = null
  }, [])

  const updatePointer = useCallback(
    (clientY: number, containerRect: DOMRect) => {
      if (!enabled) {
        stop()
        return
      }

      const distFromTop = clientY - containerRect.top
      const distFromBottom = containerRect.bottom - clientY

      let speed = 0
      if (distFromTop < gutter && distFromTop >= 0) {
        const ratio = 1 - distFromTop / gutter
        speed = -Math.round(ratio * maxSpeed)
      } else if (distFromBottom < gutter && distFromBottom >= 0) {
        const ratio = 1 - distFromBottom / gutter
        speed = Math.round(ratio * maxSpeed)
      }

      speedRef.current = speed
      if (speed === 0) {
        previousTimestampRef.current = null
      }
    },
    [enabled, gutter, maxSpeed, stop]
  )

  const step = useCallback(
    (timestamp: number) => {
      const container = containerRef.current
      const speed = speedRef.current
      if (!enabled || !container || speed === 0) {
        previousTimestampRef.current = null
        return false
      }

      const previousTimestamp = previousTimestampRef.current
      const frameFactor =
        previousTimestamp === null
          ? 1
          : Math.min(
              Math.max((timestamp - previousTimestamp) / FRAME_DURATION_MS, 0),
              2
            )

      previousTimestampRef.current = timestamp
      container.scrollBy(0, speed * frameFactor)
      return true
    },
    [containerRef, enabled]
  )

  return { updatePointer, step, stop }
}
