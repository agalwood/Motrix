import type { RefObject } from 'react'

export interface MarqueeOverlayProps {
  containerRef: RefObject<HTMLDivElement | null>
  rowHeight: number
  totalCount: number
  headerHeight?: number
  enabled?: boolean
  minDragDistance?: number
  scrollGutter?: number
  scrollMaxSpeed?: number
  onSelectionChange: (startIndex: number, endIndex: number) => void
  onSelectionEnd: () => void
}

export interface DragState {
  originX: number
  originY: number
  originScrollTop: number
  currentX: number
  currentY: number
  containerRect: DOMRect
  active: boolean
}
