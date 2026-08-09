import type { StoreApi, UseBoundStore } from 'zustand'

export interface SelectionState<T> {
  // State
  items: T[]
  /** Live selection, including in-progress marquee preview. */
  selectedIds: Set<string>
  /** Selection after the latest committed user action. */
  committedSelectedIds: Set<string>
  focusedIndex: number | null
  lastActionIndex: number | null
  /** IDs preserved before a marquee/range operation (for Shift merging) */
  preservedIds: Set<string>

  // Commands
  select: (id: string) => void
  toggle: (id: string) => void
  rangeSelect: (toIndex: number) => void
  selectAll: () => void
  clearSelection: () => void
  setItems: (items: T[]) => void

  // Marquee
  marqueeSelect: (startIndex: number, endIndex: number) => void
  marqueeEnd: () => void

  // Focus + keyboard
  moveFocus: (delta: number) => void
  focusedSelect: () => void
  shiftMoveFocus: (delta: number) => void

  // Queries
  isSelected: (id: string) => boolean
  selectedCount: () => number
}

export type SelectionStore<T> = UseBoundStore<StoreApi<SelectionState<T>>>
