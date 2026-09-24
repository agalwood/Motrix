import type { CSSProperties, HTMLAttributes, ReactNode, RefObject } from 'react'

export interface VirtualListProps<T> {
  items: T[]
  getId: (item: T) => string
  rowHeight: number
  headerHeight?: number
  overscan?: number
  /** Keep an active ARIA descendant mounted without scrolling it into view. */
  keepMountedIndex?: number
  /** Opt into the shared cross-platform scrollbar without changing scroll ownership. */
  scrollbar?: 'native' | 'custom'
  scrollRef?: RefObject<HTMLDivElement | null>
  renderRow: (props: RowRenderProps<T>) => ReactNode
  renderHeader?: () => ReactNode
  renderEmpty?: () => ReactNode
  className?: string
  style?: CSSProperties
  /** Keep the active descendant mounted outside the visible range. */
  activeIndex?: number
  containerProps?: Omit<
    HTMLAttributes<HTMLDivElement>,
    'children' | 'className' | 'style'
  >
}

export interface RowRenderProps<T> {
  item: T
  index: number
  style: CSSProperties
}

export interface VirtualListHandle {
  scrollToIndex: (index: number) => void
  scrollToOffset: (offset: number) => void
  getScrollOffset: () => number
  getContainerRef: () => HTMLDivElement | null
}
