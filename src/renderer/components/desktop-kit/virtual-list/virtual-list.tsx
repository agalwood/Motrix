import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollBar,
} from '@renderer/components/ui/scroll-area'
import { cn } from '@renderer/lib/utils'
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
    activeIndex,
    containerProps,
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
      for (const index of [keepMountedIndex, activeIndex]) {
        if (
          index !== undefined &&
          index >= 0 &&
          index < items.length &&
          !indices.includes(index)
        ) {
          indices.push(index)
        }
      }
      return indices.sort((a, b) => a - b)
    },
    [keepMountedIndex, activeIndex, items.length]
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
    scrollToOffset(offset: number) {
      virtualizer.scrollToOffset(offset)
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
      <ScrollArea className={cn('flex flex-col', className)} style={style}>
        <ScrollAreaViewport
          ref={containerRef}
          data-testid="virtual-list-container"
          tabIndex={-1}
          {...containerProps}
          className="relative min-h-0"
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
      {...containerProps}
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
