import { useCallback, useEffect, useRef } from 'react'
import type { DragState, MarqueeOverlayProps } from './types'
import { useAutoScroll } from './use-auto-scroll'

const Z_MARQUEE = 10
const MIN_VISIBLE_RECT_SIZE = 0.001

function setRectGeometry(
  box: SVGRectElement,
  x: number,
  y: number,
  width: number,
  height: number
) {
  box.setAttribute('x', String(x))
  box.setAttribute('y', String(y))
  box.setAttribute('width', String(width))
  box.setAttribute('height', String(height))
}

export function MarqueeOverlay(props: MarqueeOverlayProps) {
  const {
    containerRef,
    rowHeight,
    totalCount,
    headerHeight = 0,
    enabled = true,
    minDragDistance = 5,
    scrollGutter = 100,
    scrollMaxSpeed = 15,
    onSelectionChange,
    onSelectionEnd,
  } = props

  const boxRef = useRef<SVGRectElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const rafRef = useRef<number | null>(null)

  const {
    updatePointer: updateAutoScrollPointer,
    step: stepAutoScroll,
    stop: stopAutoScroll,
  } = useAutoScroll({
    containerRef,
    gutter: scrollGutter,
    maxSpeed: scrollMaxSpeed,
    enabled,
  })

  const computeIndices = useCallback(
    (y1: number, y2: number, scrollTop: number) => {
      const absTop = Math.min(y1, y2) + scrollTop - headerHeight
      const absBottom = Math.max(y1, y2) + scrollTop - headerHeight
      const startIndex = Math.max(0, Math.floor(absTop / rowHeight))
      const endIndex = Math.min(
        totalCount - 1,
        Math.floor(absBottom / rowHeight)
      )
      return { startIndex, endIndex }
    },
    [rowHeight, totalCount, headerHeight]
  )

  const hideBox = useCallback(() => {
    const box = boxRef.current
    if (!box) return

    box.style.opacity = '0'
    setRectGeometry(box, 0, 0, 0, 0)
  }, [])

  const paintDragFrame = useCallback(() => {
    const drag = dragRef.current
    const container = containerRef.current
    const box = boxRef.current
    if (!drag?.active || !container || !box) return

    const scrollDelta = container.scrollTop - drag.originScrollTop
    const adjustedOriginY = drag.originY - scrollDelta
    const minY = Math.min(adjustedOriginY, drag.currentY)
    const maxY = Math.max(adjustedOriginY, drag.currentY)
    const minX = Math.min(drag.originX, drag.currentX)
    const maxX = Math.max(drag.originX, drag.currentX)
    const width = Math.max(maxX - minX, MIN_VISIBLE_RECT_SIZE)
    const height = Math.max(maxY - minY, MIN_VISIBLE_RECT_SIZE)

    setRectGeometry(box, minX, minY, width, height)
    box.style.opacity = '1'

    const range = computeIndices(
      adjustedOriginY,
      drag.currentY,
      container.scrollTop
    )
    if (range.startIndex <= range.endIndex) {
      onSelectionChange(range.startIndex, range.endIndex)
    }
  }, [computeIndices, containerRef, onSelectionChange])

  const renderDragFrame = useCallback(
    (timestamp: number) => {
      const shouldContinue = stepAutoScroll(timestamp)
      paintDragFrame()
      return shouldContinue
    },
    [paintDragFrame, stepAutoScroll]
  )

  const scheduleUpdate = useCallback(() => {
    if (rafRef.current !== null) return

    const runFrame = (timestamp: number) => {
      rafRef.current = null
      const shouldContinue = renderDragFrame(timestamp)
      if (shouldContinue && rafRef.current === null) {
        rafRef.current = requestAnimationFrame(runFrame)
      }
    }

    rafRef.current = requestAnimationFrame(runFrame)
  }, [renderDragFrame])

  const onMouseDown = useCallback(
    (event: MouseEvent) => {
      if (!enabled || event.button !== 0) return
      const container = containerRef.current
      if (!container) return

      const containerRect = container.getBoundingClientRect()
      const x = event.clientX - containerRect.left
      const y = event.clientY - containerRect.top

      dragRef.current = {
        originX: x,
        originY: y,
        originScrollTop: container.scrollTop,
        currentX: x,
        currentY: y,
        containerRect,
        active: false,
      }
    },
    [containerRef, enabled]
  )

  const onMouseMove = useCallback(
    (event: MouseEvent) => {
      const drag = dragRef.current
      if (!drag || !containerRef.current) return

      drag.currentX = event.clientX - drag.containerRect.left
      drag.currentY = event.clientY - drag.containerRect.top

      if (!drag.active) {
        const dx = drag.currentX - drag.originX
        const dy = drag.currentY - drag.originY
        if (Math.sqrt(dx * dx + dy * dy) < minDragDistance) return
        drag.active = true
      }

      updateAutoScrollPointer(event.clientY, drag.containerRect)
      scheduleUpdate()
    },
    [containerRef, minDragDistance, scheduleUpdate, updateAutoScrollPointer]
  )

  const onScroll = useCallback(() => {
    if (dragRef.current?.active) {
      scheduleUpdate()
    }
  }, [scheduleUpdate])

  const refreshContainerRect = useCallback(() => {
    const drag = dragRef.current
    const container = containerRef.current
    if (!drag || !container) return

    const nextRect = container.getBoundingClientRect()
    const deltaX = drag.containerRect.left - nextRect.left
    const deltaY = drag.containerRect.top - nextRect.top
    drag.originX += deltaX
    drag.originY += deltaY
    drag.currentX += deltaX
    drag.currentY += deltaY
    drag.containerRect = nextRect

    if (drag.active) {
      scheduleUpdate()
    }
  }, [containerRef, scheduleUpdate])

  const onMouseUp = useCallback(() => {
    const drag = dragRef.current
    if (!drag) return

    if (drag.active) {
      paintDragFrame()
      onSelectionEnd()
    }

    hideBox()
    dragRef.current = null
    stopAutoScroll()
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [hideBox, onSelectionEnd, paintDragFrame, stopAutoScroll])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(refreshContainerRect)

    container.addEventListener('mousedown', onMouseDown)
    container.addEventListener('scroll', onScroll)
    window.addEventListener('mousemove', onMouseMove, true)
    window.addEventListener('mouseup', onMouseUp, true)
    window.addEventListener('resize', refreshContainerRect)
    resizeObserver?.observe(container)

    return () => {
      container.removeEventListener('mousedown', onMouseDown)
      container.removeEventListener('scroll', onScroll)
      window.removeEventListener('mousemove', onMouseMove, true)
      window.removeEventListener('mouseup', onMouseUp, true)
      window.removeEventListener('resize', refreshContainerRect)
      resizeObserver?.disconnect()

      hideBox()
      dragRef.current = null
      stopAutoScroll()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [
    containerRef,
    enabled,
    hideBox,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onScroll,
    refreshContainerRect,
    stopAutoScroll,
  ])

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full overflow-hidden"
      style={{ zIndex: Z_MARQUEE }}
    >
      <rect
        ref={boxRef}
        data-testid="marquee-box"
        x={0}
        y={0}
        width={0}
        height={0}
        style={{
          fill: 'color-mix(in oklab, var(--color-ring, currentColor) 12%, transparent)',
          stroke:
            'color-mix(in oklab, var(--color-ring, currentColor) 78%, var(--color-foreground, currentColor))',
          strokeWidth: 1,
          opacity: 0,
        }}
      />
    </svg>
  )
}
