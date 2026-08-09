import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { createSelectionStore } from '../selection/create-selection-store'
import type { SelectionStore } from '../selection/types'
import type { VirtualListHandle } from '../virtual-list/types'

interface UseSelectableListOptions<T> {
  items: T[]
  getId: (item: T) => string
  rowHeight: number
  headerHeight?: number
  marquee?: boolean
  store?: SelectionStore<T>
}

interface RowProps {
  selected: boolean
  focused: boolean
  onClick: (e: ReactMouseEvent) => void
  onCheckboxChange: () => void
}

interface HeaderCheckboxState {
  checked: boolean
  indeterminate: boolean
  onChange: () => void
}

interface UseSelectableListReturn<T> {
  listRef: React.RefObject<VirtualListHandle | null>
  listProps: {
    items: T[]
    getId: (item: T) => string
    rowHeight: number
    scrollRef: React.RefObject<HTMLDivElement | null>
  }
  marqueeProps: {
    containerRef: React.RefObject<HTMLDivElement | null>
    rowHeight: number
    totalCount: number
    headerHeight: number
    enabled: boolean
    onSelectionChange: (start: number, end: number) => void
    onSelectionEnd: () => void
  }
  selection: SelectionStore<T>
  getRowProps: (index: number) => RowProps
  headerCheckbox: HeaderCheckboxState
  onKeyDown: (e: ReactKeyboardEvent) => void
}

export function useSelectableList<T>(
  options: UseSelectableListOptions<T>
): UseSelectableListReturn<T> {
  const { items, getId, rowHeight, headerHeight = 0, marquee = true } = options

  const listRef = useRef<VirtualListHandle | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: getId is assumed stable — re-creating the store on getId change would destroy all selection state
  const fallbackStore = useMemo(() => createSelectionStore<T>(getId), [])
  const store = options.store ?? fallbackStore

  useEffect(() => {
    store.getState().setItems(items)
  }, [store, items])

  useEffect(() => {
    return store.subscribe((state, prev) => {
      if (
        state.focusedIndex !== null &&
        state.focusedIndex !== prev.focusedIndex
      ) {
        listRef.current?.scrollToIndex(state.focusedIndex)
      }
    })
  }, [store])

  const selectedIds = store((s) => s.selectedIds)
  const focusedIndex = store((s) => s.focusedIndex)

  const getRowProps = useCallback(
    (index: number): RowProps => {
      const item = items[index]
      if (!item) {
        return {
          selected: false,
          focused: false,
          onClick: () => {},
          onCheckboxChange: () => {},
        }
      }
      const id = getId(item)
      return {
        selected: selectedIds.has(id),
        focused: focusedIndex === index,
        onClick: (e: ReactMouseEvent) => {
          const state = store.getState()
          if (e.shiftKey) {
            state.rangeSelect(index)
          } else if (e.ctrlKey || e.metaKey) {
            state.toggle(id)
          } else {
            state.select(id)
          }
        },
        onCheckboxChange: () => {
          store.getState().toggle(id)
        },
      }
    },
    [items, getId, selectedIds, focusedIndex, store]
  )

  const headerCheckbox = useMemo((): HeaderCheckboxState => {
    const count = selectedIds.size
    const total = items.length
    return {
      checked: total > 0 && count === total,
      indeterminate: count > 0 && count < total,
      onChange: () => {
        if (count > 0) {
          store.getState().clearSelection()
        } else {
          store.getState().selectAll()
        }
      },
    }
  }, [selectedIds, items.length, store])

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      const state = store.getState()
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          if (e.shiftKey) {
            state.shiftMoveFocus(1)
          } else {
            state.moveFocus(1)
          }
          break
        case 'ArrowUp':
          e.preventDefault()
          if (e.shiftKey) {
            state.shiftMoveFocus(-1)
          } else {
            state.moveFocus(-1)
          }
          break
        case ' ':
          e.preventDefault()
          state.focusedSelect()
          break
        case 'a':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            state.selectAll()
          }
          break
        case 'Escape':
          state.clearSelection()
          break
      }
    },
    [store]
  )

  const marqueeProps = useMemo(
    () => ({
      containerRef,
      rowHeight,
      totalCount: items.length,
      headerHeight,
      enabled: marquee,
      onSelectionChange: (start: number, end: number) => {
        store.getState().marqueeSelect(start, end)
      },
      onSelectionEnd: () => {
        store.getState().marqueeEnd()
      },
    }),
    [rowHeight, items.length, headerHeight, marquee, store]
  )

  return {
    listRef,
    listProps: { items, getId, rowHeight, scrollRef: containerRef },
    marqueeProps,
    selection: store,
    getRowProps,
    headerCheckbox,
    onKeyDown,
  }
}
