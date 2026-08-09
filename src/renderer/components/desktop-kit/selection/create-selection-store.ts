import { create } from 'zustand'
import type { SelectionState, SelectionStore } from './types'

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

interface MarqueeRangeSnapshot {
  start: number
  end: number
  itemsRevision: number
}

export function createSelectionStore<T>(
  getId: (item: T) => string
): SelectionStore<T> {
  // O(1) id→index lookup, rebuilt in setItems
  let indexById = new Map<string, number>()
  // Id-anchored focus and range tracking — survives item reorder.
  // Public focusedIndex / lastActionIndex are derived from these
  // during setItems against the latest indexById.
  let focusedId: string | null = null
  let lastActionId: string | null = null
  // A new items reference changes the meaning of an index range, even when
  // its numeric bounds stay the same.
  let itemsRevision = 0
  let lastMarqueeRange: MarqueeRangeSnapshot | null = null

  const resetMarqueeRange = () => {
    lastMarqueeRange = null
  }

  return create<SelectionState<T>>((set, get) => ({
    items: [],
    selectedIds: new Set<string>(),
    committedSelectedIds: new Set<string>(),
    focusedIndex: null,
    lastActionIndex: null,
    preservedIds: new Set<string>(),

    select(id: string) {
      resetMarqueeRange()
      const index = indexById.get(id) ?? -1
      if (index >= 0) {
        focusedId = id
        lastActionId = id
      }
      set({
        selectedIds: new Set([id]),
        committedSelectedIds: new Set([id]),
        focusedIndex: index >= 0 ? index : get().focusedIndex,
        lastActionIndex: index >= 0 ? index : get().lastActionIndex,
      })
    },

    toggle(id: string) {
      resetMarqueeRange()
      const { selectedIds } = get()
      const next = new Set(selectedIds)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      const index = indexById.get(id) ?? -1
      if (index >= 0) {
        lastActionId = id
      }
      set({
        selectedIds: next,
        committedSelectedIds: new Set(next),
        lastActionIndex: index >= 0 ? index : get().lastActionIndex,
      })
    },

    rangeSelect(toIndex: number) {
      resetMarqueeRange()
      const { items, lastActionIndex } = get()
      const from = lastActionIndex ?? 0
      const start = Math.min(from, toIndex)
      const end = Math.max(from, toIndex)
      const next = new Set<string>()
      for (let i = start; i <= end; i++) {
        if (i >= 0 && i < items.length) {
          next.add(getId(items[i]))
        }
      }
      set({ selectedIds: next, committedSelectedIds: new Set(next) })
    },

    selectAll() {
      resetMarqueeRange()
      const { items } = get()
      const next = new Set(items.map(getId))
      set({ selectedIds: next, committedSelectedIds: new Set(next) })
    },

    clearSelection() {
      resetMarqueeRange()
      if (get().selectedIds.size === 0 && get().lastActionIndex === null) return
      lastActionId = null
      set({
        selectedIds: new Set<string>(),
        committedSelectedIds: new Set<string>(),
        lastActionIndex: null,
      })
    },

    setItems(newItems: T[]) {
      const {
        items: prev,
        selectedIds,
        committedSelectedIds,
        focusedIndex: prevFocusedIndex,
      } = get()
      if (newItems === prev) return
      itemsRevision += 1
      indexById = new Map(newItems.map((item, i) => [getId(item), i]))

      // Prune selectedIds — keep ids that still exist
      let needsPrune = false
      for (const id of selectedIds) {
        if (!indexById.has(id)) {
          needsPrune = true
          break
        }
      }
      let pruned = selectedIds
      if (needsPrune) {
        pruned = new Set<string>()
        for (const id of selectedIds) {
          if (indexById.has(id)) {
            pruned.add(id)
          }
        }
      }

      let needsCommitPrune = false
      for (const id of committedSelectedIds) {
        if (!indexById.has(id)) {
          needsCommitPrune = true
          break
        }
      }
      let committedPruned = committedSelectedIds
      if (needsCommitPrune) {
        committedPruned = new Set<string>()
        for (const id of committedSelectedIds) {
          if (indexById.has(id)) {
            committedPruned.add(id)
          }
        }
      }

      // Re-resolve focus by id; fall back to clamp(old index) for visual
      // continuity if the focused task was removed (Finder-like behavior).
      let nextFocusedIndex: number | null = null
      if (newItems.length > 0) {
        if (focusedId !== null) {
          const idx = indexById.get(focusedId)
          if (idx !== undefined) {
            nextFocusedIndex = idx
          } else {
            // focused task was removed — drop id, clamp old index for continuity
            focusedId = null
            nextFocusedIndex =
              prevFocusedIndex !== null
                ? clamp(prevFocusedIndex, 0, newItems.length - 1)
                : null
          }
        } else {
          // no id-anchor; preserve raw index clamp behavior
          nextFocusedIndex =
            prevFocusedIndex !== null
              ? clamp(prevFocusedIndex, 0, newItems.length - 1)
              : null
        }
      } else {
        focusedId = null
      }

      // Re-resolve range anchor by id; clear (null) on removal — stale anchor
      // would silently select wrong tasks, null falls back to 0 in rangeSelect.
      let nextLastActionIndex: number | null = null
      if (newItems.length > 0 && lastActionId !== null) {
        const idx = indexById.get(lastActionId)
        if (idx !== undefined) {
          nextLastActionIndex = idx
        } else {
          lastActionId = null
        }
      } else if (newItems.length === 0) {
        lastActionId = null
      }

      set({
        items: newItems,
        selectedIds: pruned,
        committedSelectedIds: committedPruned,
        focusedIndex: nextFocusedIndex,
        lastActionIndex: nextLastActionIndex,
      })
    },

    marqueeSelect(startIndex: number, endIndex: number) {
      const { items, preservedIds } = get()
      const start =
        items.length === 0
          ? 0
          : clamp(Math.min(startIndex, endIndex), 0, items.length - 1)
      const end =
        items.length === 0
          ? -1
          : clamp(Math.max(startIndex, endIndex), 0, items.length - 1)

      if (
        lastMarqueeRange?.start === start &&
        lastMarqueeRange.end === end &&
        lastMarqueeRange.itemsRevision === itemsRevision
      ) {
        return
      }
      lastMarqueeRange = { start, end, itemsRevision }

      const next = new Set(preservedIds)
      for (let i = start; i <= end; i++) {
        next.add(getId(items[i]))
      }
      set({ selectedIds: next })
    },

    marqueeEnd() {
      resetMarqueeRange()
      const { selectedIds, items } = get()
      let maxIndex = 0
      let anchorId: string | null = null
      for (let i = items.length - 1; i >= 0; i--) {
        if (selectedIds.has(getId(items[i]))) {
          maxIndex = i
          anchorId = getId(items[i])
          break
        }
      }
      lastActionId = selectedIds.size > 0 ? anchorId : null
      set({
        committedSelectedIds: new Set(selectedIds),
        preservedIds: new Set<string>(),
        lastActionIndex: selectedIds.size > 0 ? maxIndex : null,
      })
    },

    moveFocus(delta: number) {
      const { focusedIndex, items } = get()
      if (items.length === 0) return
      const current = focusedIndex ?? -1
      const next = clamp(current + delta, 0, items.length - 1)
      focusedId = getId(items[next])
      set({ focusedIndex: next })
    },

    focusedSelect() {
      resetMarqueeRange()
      const { focusedIndex, items } = get()
      if (focusedIndex === null || focusedIndex >= items.length) return
      get().toggle(getId(items[focusedIndex]))
    },

    shiftMoveFocus(delta: number) {
      resetMarqueeRange()
      const { focusedIndex, items, selectedIds } = get()
      if (items.length === 0) return
      const current = focusedIndex ?? -1
      const next = clamp(current + delta, 0, items.length - 1)
      const nextId = getId(items[next])
      focusedId = nextId
      if (selectedIds.has(nextId)) {
        set({ focusedIndex: next })
      } else {
        const updated = new Set(selectedIds)
        updated.add(nextId)
        set({
          focusedIndex: next,
          selectedIds: updated,
          committedSelectedIds: new Set(updated),
        })
      }
    },

    isSelected(id: string) {
      return get().selectedIds.has(id)
    },

    selectedCount() {
      return get().selectedIds.size
    },
  }))
}
