import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollBar,
} from '@renderer/components/ui/scroll-area'
import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
} from '@tanstack/react-virtual'
import {
  type ForwardedRef,
  forwardRef,
  type ReactElement,
  useCallback,
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
    headerHeight = 0,
    overscan = 5,
    keepMountedIndex,
    scrollbar = 'native',
    scrollRef,
    renderRow,
    renderHeader,
    renderEmpty,
    className,
    style,
  } = props

  const internalRef = useRef<HTMLDivElement>(null)
  const containerRef = scrollRef ?? internalRef

  const getItemKey = useCallback(
    (index: number) => getId(items[index]),
    [getId, items]
  )
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indices = defaultRangeExtractor(range)
      if (
        keepMountedIndex !== undefined &&
        keepMountedIndex >= 0 &&
        keepMountedIndex < items.length &&
        !indices.includes(keepMountedIndex)
      ) {
        indices.push(keepMountedIndex)
        indices.sort((a, b) => a - b)
      }
      return indices
    },
    [keepMountedIndex, items.length]
  )
  const virtualizer = useVirtualizer({
    count: items.length,
    getItemKey,
    scrollMargin: headerHeight,
    scrollPaddingStart: headerHeight,
    getScrollElement: () => containerRef.current,
    estimateSize: () => rowHeight,
    overscan,
    rangeExtractor,
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

  const content = (
    <>
      {renderHeader?.()}
      {items.length === 0 && renderEmpty ? (
        renderEmpty()
      ) : (
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
                  transform: `translateY(${virtualRow.start - headerHeight}px)`,
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
      )}
    </>
  )

  if (scrollbar === 'custom') {
    return (
      <ScrollArea className={className} style={style}>
        <ScrollAreaViewport
          ref={containerRef}
          data-testid="virtual-list-container"
          tabIndex={-1}
          className="relative"
        >
          <ScrollAreaContent style={{ minWidth: '100%' }}>
            {content}
          </ScrollAreaContent>
        </ScrollAreaViewport>
        <ScrollBar />
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    )
  }

  return (
    <div
      ref={containerRef}
      data-testid="virtual-list-container"
      className={className}
      style={{ overflow: 'auto', position: 'relative', ...style }}
    >
      {content}
    </div>
  )
}

export const VirtualList = forwardRef(VirtualListInner) as <T>(
  props: VirtualListProps<T> & { ref?: ForwardedRef<VirtualListHandle> }
) => ReactElement
