import { useVirtualizer } from '@tanstack/react-virtual'
import {
  type ForwardedRef,
  forwardRef,
  type ReactElement,
  useImperativeHandle,
  useRef,
} from 'react'
import type { VirtualListHandle, VirtualListProps } from './types'

function VirtualListInner<T>(
  props: VirtualListProps<T>,
  ref: ForwardedRef<VirtualListHandle>
) {
  const {
    items,
    getId,
    rowHeight,
    overscan = 5,
    scrollRef,
    renderRow,
    renderHeader,
    renderEmpty,
    className,
    style,
  } = props

  const internalRef = useRef<HTMLDivElement>(null)
  const containerRef = scrollRef ?? internalRef

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => rowHeight,
    overscan,
  })

  useImperativeHandle(ref, () => ({
    scrollToIndex(index: number) {
      virtualizer.scrollToIndex(index, { align: 'auto' })
    },
    getScrollOffset() {
      return virtualizer.scrollOffset ?? 0
    },
    getContainerRef() {
      return containerRef.current
    },
  }))

  if (items.length === 0 && renderEmpty) {
    return (
      <div
        ref={containerRef}
        data-testid="virtual-list-container"
        className={className}
        style={{
          overflow: 'auto',
          position: 'relative',
          ...style,
        }}
      >
        {renderHeader?.()}
        {renderEmpty()}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      data-testid="virtual-list-container"
      className={className}
      style={{
        overflow: 'auto',
        position: 'relative',
        ...style,
      }}
    >
      {renderHeader?.()}
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index]
          return (
            <div
              key={getId(item)}
              data-index={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: rowHeight,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {renderRow({
                item,
                index: virtualRow.index,
                style: { height: rowHeight },
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export const VirtualList = forwardRef(VirtualListInner) as <T>(
  props: VirtualListProps<T> & { ref?: ForwardedRef<VirtualListHandle> }
) => ReactElement
