import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  /** Opt in without changing the focus-only keyboard model of other lists. */
  nativeSelection?: boolean
  macOS?: boolean
  getText?: (item: T) => string
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
    headerHeight: number
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
  const {
    items,
    getId,
    rowHeight,
    headerHeight = 0,
    marquee = true,
    nativeSelection = false,
    macOS = false,
    getText,
  } = options

  const listRef = useRef<VirtualListHandle | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: getId is assumed stable — re-creating the store on getId change would destroy all selection state
  const fallbackStore = useMemo(() => createSelectionStore<T>(getId), [])
  const store = options.store ?? fallbackStore

  useLayoutEffect(() => {
    store.getState().setItems(items)
  }, [store, items])

  const selectedIds = store((s) => s.selectedIds)
  const focusedIndex = store((s) => s.focusedIndex)
  const focusedItemId = store((state) => {
    const item =
      state.focusedIndex === null ? undefined : state.items[state.focusedIndex]
    return item ? getId(item) : null
  })
  const previousFocus = useRef<string | null>(null)
  const typeSelection = useRef({ text: '', at: 0 })

  // Also reveal focus after a filtered list remounts. A store subscription
  // alone misses the initial setItems reindex before its listener attaches.
  useEffect(() => {
    if (
      focusedIndex !== null &&
      (!nativeSelection || previousFocus.current !== focusedItemId)
    ) {
      listRef.current?.scrollToIndex(focusedIndex)
    }
    previousFocus.current = focusedItemId
  }, [focusedIndex, focusedItemId, nativeSelection])

  const hasItems = items.length > 0
  useEffect(() => {
    const container = listRef.current?.getContainerRef()
    if (!hasItems || !container || typeof ResizeObserver === 'undefined') return
    // Window and panel resizing can shrink the scrollport without changing focus.
    // Observe after the virtualizer so its viewport measurement is current.
    const observer = new ResizeObserver(() => {
      const index = store.getState().focusedIndex
      if (index !== null) listRef.current?.scrollToIndex(index)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [hasItems, store])

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
          if (nativeSelection && macOS && e.ctrlKey) return
          if (e.shiftKey) {
            if (nativeSelection) state.extendSelection(index)
            else state.rangeSelect(index)
          } else if (e.metaKey || (e.ctrlKey && (!nativeSelection || !macOS))) {
            state.toggle(id)
            if (nativeSelection) state.focus(id)
          } else {
            state.select(id)
          }
        },
        onCheckboxChange: () => {
          store.getState().toggle(id)
        },
      }
    },
    [items, getId, selectedIds, focusedIndex, store, nativeSelection, macOS]
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
      if (e.defaultPrevented || e.nativeEvent.isComposing) return
      if (
        e.target instanceof Element &&
        e.target.closest(
          'input, textarea, select, button, [contenteditable="true"], [role="menu"], [role="separator"]'
        )
      )
        return
      const state = store.getState()
      if (nativeSelection) {
        if (
          (e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey
        ) {
          e.preventDefault()
          state.moveSelection(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
          const index = store.getState().focusedIndex
          if (index !== null) listRef.current?.scrollToIndex(index)
          return
        }
        if (
          e.key.toLowerCase() === 'a' &&
          (e.metaKey || (!macOS && e.ctrlKey))
        ) {
          e.preventDefault()
          if (e.shiftKey) state.clearSelection()
          else state.selectAll()
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          state.clearSelection()
          return
        }
        if (
          getText &&
          e.key.length === 1 &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey
        ) {
          e.preventDefault()
          const now = Date.now()
          const key = e.key.toLocaleLowerCase()
          const previous =
            now - typeSelection.current.at < 700
              ? typeSelection.current.text
              : ''
          const text = previous + key
          typeSelection.current = { text, at: now }
          const repeated = [...text].every((letter) => letter === key)
          const prefix = repeated ? key : text
          const from =
            (state.focusedIndex ?? -1) + (previous && !repeated ? 0 : 1)
          for (let offset = 0; offset < state.items.length; offset++) {
            const index =
              (((from + offset) % state.items.length) + state.items.length) %
              state.items.length
            if (
              getText(state.items[index]).toLocaleLowerCase().startsWith(prefix)
            ) {
              state.select(getId(state.items[index]))
              listRef.current?.scrollToIndex(index)
              break
            }
          }
        }
        return
      }
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
    [store, nativeSelection, macOS, getText, getId]
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
    listProps: {
      items,
      getId,
      rowHeight,
      headerHeight,
      scrollRef: containerRef,
    },
    marqueeProps,
    selection: store,
    getRowProps,
    headerCheckbox,
    onKeyDown,
  }
}
