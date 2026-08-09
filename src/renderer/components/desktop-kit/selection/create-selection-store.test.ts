import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSelectionStore } from './create-selection-store'
import type { SelectionStore } from './types'

interface TestItem {
  id: string
  name: string
}

const makeItems = (count: number): TestItem[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    name: `Item ${i}`,
  }))

describe('createSelectionStore', () => {
  let store: SelectionStore<TestItem>
  let items: TestItem[]

  beforeEach(() => {
    items = makeItems(10)
    store = createSelectionStore<TestItem>((item) => item.id)
    store.getState().setItems(items)
  })

  describe('select', () => {
    it('selects a single item and clears others', () => {
      const { select, toggle } = store.getState()
      toggle('item-0')
      toggle('item-1')
      select('item-5')

      const state = store.getState()
      expect(state.selectedIds.size).toBe(1)
      expect(state.selectedIds.has('item-5')).toBe(true)
    })

    it('updates lastActionIndex', () => {
      store.getState().select('item-3')
      expect(store.getState().lastActionIndex).toBe(3)
    })

    it('updates focusedIndex to selected item', () => {
      store.getState().select('item-7')
      expect(store.getState().focusedIndex).toBe(7)
    })
  })

  describe('toggle', () => {
    it('adds item to selection without clearing others', () => {
      const { toggle } = store.getState()
      toggle('item-0')
      toggle('item-2')

      const state = store.getState()
      expect(state.selectedIds.size).toBe(2)
      expect(state.selectedIds.has('item-0')).toBe(true)
      expect(state.selectedIds.has('item-2')).toBe(true)
    })

    it('removes item if already selected', () => {
      const { toggle } = store.getState()
      toggle('item-0')
      toggle('item-0')
      expect(store.getState().selectedIds.size).toBe(0)
    })

    it('updates lastActionIndex', () => {
      store.getState().toggle('item-4')
      expect(store.getState().lastActionIndex).toBe(4)
    })
  })

  describe('selectAll', () => {
    it('selects all items', () => {
      store.getState().selectAll()
      expect(store.getState().selectedIds.size).toBe(10)
    })
  })

  describe('clearSelection', () => {
    it('empties selection', () => {
      store.getState().selectAll()
      store.getState().clearSelection()
      expect(store.getState().selectedIds.size).toBe(0)
    })

    it('resets lastActionIndex', () => {
      store.getState().select('item-3')
      store.getState().clearSelection()
      expect(store.getState().lastActionIndex).toBeNull()
    })
  })

  describe('rangeSelect', () => {
    it('selects range from lastActionIndex to target', () => {
      store.getState().select('item-2')
      store.getState().rangeSelect(5)

      const state = store.getState()
      expect(state.selectedIds.size).toBe(4)
      for (let i = 2; i <= 5; i++) {
        expect(state.selectedIds.has(`item-${i}`)).toBe(true)
      }
    })

    it('works when target is before lastActionIndex', () => {
      store.getState().select('item-5')
      store.getState().rangeSelect(2)

      const state = store.getState()
      expect(state.selectedIds.size).toBe(4)
      for (let i = 2; i <= 5; i++) {
        expect(state.selectedIds.has(`item-${i}`)).toBe(true)
      }
    })

    it('defaults to index 0 when no lastActionIndex', () => {
      store.getState().rangeSelect(3)

      const state = store.getState()
      expect(state.selectedIds.size).toBe(4)
      for (let i = 0; i <= 3; i++) {
        expect(state.selectedIds.has(`item-${i}`)).toBe(true)
      }
    })
  })

  describe('setItems', () => {
    it('prunes selectedIds of removed items', () => {
      store.getState().selectAll()
      store.getState().setItems(makeItems(5))

      const state = store.getState()
      expect(state.selectedIds.size).toBe(5)
      expect(state.selectedIds.has('item-9')).toBe(false)
    })

    it('preserves valid selectedIds', () => {
      store.getState().toggle('item-1')
      store.getState().setItems(makeItems(10))
      expect(store.getState().selectedIds.has('item-1')).toBe(true)
    })

    it('clamps focusedIndex when items shrink', () => {
      store.getState().moveFocus(1) // focus index 0
      for (let i = 0; i < 8; i++) store.getState().moveFocus(1)
      // focusedIndex is now 8
      store.getState().setItems(makeItems(3))
      expect(store.getState().focusedIndex).toBe(2)
    })
  })

  describe('queries', () => {
    it('isSelected returns correct boolean', () => {
      store.getState().toggle('item-3')
      expect(store.getState().isSelected('item-3')).toBe(true)
      expect(store.getState().isSelected('item-4')).toBe(false)
    })

    it('selectedCount returns correct count', () => {
      store.getState().toggle('item-0')
      store.getState().toggle('item-1')
      expect(store.getState().selectedCount()).toBe(2)
    })
  })

  describe('moveFocus', () => {
    it('moves focus down from null to 0', () => {
      store.getState().moveFocus(1)
      expect(store.getState().focusedIndex).toBe(0)
    })

    it('moves focus down', () => {
      store.getState().moveFocus(1) // 0
      store.getState().moveFocus(1) // 1
      expect(store.getState().focusedIndex).toBe(1)
    })

    it('moves focus up', () => {
      store.getState().moveFocus(1) // 0
      store.getState().moveFocus(1) // 1
      store.getState().moveFocus(1) // 2
      store.getState().moveFocus(-1) // 1
      expect(store.getState().focusedIndex).toBe(1)
    })

    it('clamps at bottom', () => {
      for (let i = 0; i < 20; i++) store.getState().moveFocus(1)
      expect(store.getState().focusedIndex).toBe(9)
    })

    it('clamps at top', () => {
      store.getState().moveFocus(1) // 0
      store.getState().moveFocus(-1) // still 0
      expect(store.getState().focusedIndex).toBe(0)
    })
  })

  describe('focusedSelect', () => {
    it('toggles selection at focused row', () => {
      store.getState().moveFocus(1) // focus 0
      store.getState().moveFocus(1) // focus 1
      store.getState().moveFocus(1) // focus 2
      store.getState().focusedSelect()
      expect(store.getState().isSelected('item-2')).toBe(true)
    })

    it('toggles off if already selected', () => {
      store.getState().moveFocus(1) // focus 0
      store.getState().focusedSelect() // select
      store.getState().focusedSelect() // deselect
      expect(store.getState().isSelected('item-0')).toBe(false)
    })

    it('does nothing if no focus', () => {
      store.getState().focusedSelect()
      expect(store.getState().selectedIds.size).toBe(0)
    })
  })

  describe('shiftMoveFocus', () => {
    it('extends selection downward', () => {
      store.getState().moveFocus(1) // focus 0
      store.getState().focusedSelect() // select 0
      store.getState().shiftMoveFocus(1) // extend to 1
      store.getState().shiftMoveFocus(1) // extend to 2

      const state = store.getState()
      expect(state.focusedIndex).toBe(2)
      expect(state.selectedIds.size).toBe(3)
      expect(state.isSelected('item-0')).toBe(true)
      expect(state.isSelected('item-1')).toBe(true)
      expect(state.isSelected('item-2')).toBe(true)
    })

    it('extends selection upward', () => {
      store.getState().moveFocus(1) // 0
      store.getState().moveFocus(1) // 1
      store.getState().moveFocus(1) // 2
      store.getState().focusedSelect() // select 2
      store.getState().shiftMoveFocus(-1) // extend to 1
      store.getState().shiftMoveFocus(-1) // extend to 0

      const state = store.getState()
      expect(state.focusedIndex).toBe(0)
      expect(state.selectedIds.size).toBe(3)
    })
  })

  describe('marqueeSelect', () => {
    it('sets preview selection for range', () => {
      store.getState().marqueeSelect(2, 5)

      const state = store.getState()
      expect(state.selectedIds.size).toBe(4)
      expect(state.committedSelectedIds.size).toBe(0)
      for (let i = 2; i <= 5; i++) {
        expect(state.isSelected(`item-${i}`)).toBe(true)
      }
    })

    it('updates preview as range changes', () => {
      store.getState().marqueeSelect(2, 5)
      store.getState().marqueeSelect(2, 8)

      const state = store.getState()
      expect(state.selectedIds.size).toBe(7)
      expect(state.isSelected('item-5')).toBe(true)
      expect(state.isSelected('item-8')).toBe(true)
    })

    it('skips the same normalized range within one items revision', () => {
      store.getState().marqueeSelect(2, 5)
      const selectedIds = store.getState().selectedIds
      const subscriber = vi.fn()
      const unsubscribe = store.subscribe(subscriber)

      store.getState().marqueeSelect(5, 2)

      expect(subscriber).not.toHaveBeenCalled()
      expect(store.getState().selectedIds).toBe(selectedIds)
      unsubscribe()
    })

    it('re-runs a range after another selection action replaces it', () => {
      store.getState().marqueeSelect(2, 5)
      store.getState().select('item-0')
      const subscriber = vi.fn()
      const unsubscribe = store.subscribe(subscriber)

      store.getState().marqueeSelect(2, 5)

      expect(subscriber).toHaveBeenCalledOnce()
      expect([...store.getState().selectedIds].sort()).toEqual([
        'item-2',
        'item-3',
        'item-4',
        'item-5',
      ])
      unsubscribe()
    })

    it('preserves existing selection when Shift merging', () => {
      store.getState().toggle('item-0')
      store.getState().toggle('item-9')
      // Simulate shift-start: preserve current selection
      store.setState({
        preservedIds: new Set(store.getState().selectedIds),
      })
      store.getState().marqueeSelect(3, 5)

      const state = store.getState()
      expect(state.isSelected('item-0')).toBe(true)
      expect(state.isSelected('item-9')).toBe(true)
      expect(state.isSelected('item-4')).toBe(true)
    })
  })

  describe('marqueeEnd', () => {
    it('commits selection and clears preservedIds', () => {
      store.getState().marqueeSelect(2, 5)
      store.getState().marqueeEnd()

      const state = store.getState()
      expect(state.selectedIds.size).toBe(4)
      expect(state.committedSelectedIds.size).toBe(4)
      expect([...state.committedSelectedIds].sort()).toEqual([
        'item-2',
        'item-3',
        'item-4',
        'item-5',
      ])
      expect(state.preservedIds.size).toBe(0)
    })

    it('updates lastActionIndex to end of range', () => {
      store.getState().marqueeSelect(2, 5)
      store.getState().marqueeEnd()
      expect(store.getState().lastActionIndex).toBe(5)
    })

    it('allows the same range to run in a new marquee gesture', () => {
      store.getState().marqueeSelect(2, 5)
      store.getState().marqueeEnd()
      const previousSelectedIds = store.getState().selectedIds
      const subscriber = vi.fn()
      const unsubscribe = store.subscribe(subscriber)

      store.getState().marqueeSelect(2, 5)

      expect(subscriber).toHaveBeenCalledOnce()
      expect(store.getState().selectedIds).not.toBe(previousSelectedIds)
      unsubscribe()
    })
  })

  describe('createSelectionStore — mutating items (id-anchored focus + range)', () => {
    it('preserves selection and focus when only fields mutate (ids + order unchanged)', () => {
      const t1a = { id: 't1', status: 'downloading', speed: 100 }
      const t2a = { id: 't2', status: 'paused', speed: 0 }
      const s = createSelectionStore<{
        id: string
        status: string
        speed: number
      }>((t) => t.id)
      s.getState().setItems([t1a, t2a])
      s.getState().select('t1')
      expect(s.getState().focusedIndex).toBe(0)
      expect(s.getState().lastActionIndex).toBe(0)

      const t1b = { id: 't1', status: 'completed', speed: 0 }
      const t2b = { id: 't2', status: 'paused', speed: 0 }
      s.getState().setItems([t1b, t2b])

      expect(s.getState().selectedIds.has('t1')).toBe(true)
      expect(s.getState().focusedIndex).toBe(0)
      expect(s.getState().lastActionIndex).toBe(0)
    })

    it('preserves focus on the focused task when reorder keeps it at same index', () => {
      const items = [
        { id: 't1' },
        { id: 't2' },
        { id: 't3' },
        { id: 't4' },
        { id: 't5' },
      ]
      const s = createSelectionStore<{ id: string }>((t) => t.id)
      s.getState().setItems(items)
      s.getState().select('t3')
      expect(s.getState().focusedIndex).toBe(2)

      s.getState().setItems([items[4], items[0], items[2], items[1], items[3]])
      expect(s.getState().focusedIndex).toBe(2)
    })

    it('reassigns focusedIndex when the focused task moves to a new position', () => {
      const s = createSelectionStore<{ id: string }>((t) => t.id)
      s.getState().setItems([{ id: 't1' }, { id: 't2' }, { id: 't3' }])
      s.getState().select('t1')
      expect(s.getState().focusedIndex).toBe(0)

      s.getState().setItems([{ id: 't3' }, { id: 't1' }, { id: 't2' }])
      expect(s.getState().focusedIndex).toBe(1)
    })

    it('falls back to clamp(prev) when the focused task itself is removed (Finder-like continuity)', () => {
      const s = createSelectionStore<{ id: string }>((t) => t.id)
      s.getState().setItems([{ id: 't1' }, { id: 't2' }, { id: 't3' }])
      s.getState().select('t2')
      expect(s.getState().focusedIndex).toBe(1)

      s.getState().setItems([{ id: 't1' }, { id: 't3' }])
      expect(s.getState().focusedIndex).toBe(1)
    })

    it('rangeSelect uses id-anchored lastAction after reorder', () => {
      const s = createSelectionStore<{ id: string }>((t) => t.id)
      s.getState().setItems([
        { id: 't1' },
        { id: 't2' },
        { id: 't3' },
        { id: 't4' },
        { id: 't5' },
      ])
      s.getState().select('t1')
      expect(s.getState().lastActionIndex).toBe(0)

      s.getState().setItems([
        { id: 't5' },
        { id: 't4' },
        { id: 't3' },
        { id: 't2' },
        { id: 't1' },
      ])
      expect(s.getState().lastActionIndex).toBe(4)

      s.getState().rangeSelect(2)
      expect([...s.getState().selectedIds].sort()).toEqual(['t1', 't2', 't3'])
    })

    it('marqueeSelect always reflects current items at given indices (Pattern 2 live reflow)', () => {
      const s = createSelectionStore<{ id: string }>((t) => t.id)
      s.getState().setItems([
        { id: 't1' },
        { id: 't2' },
        { id: 't3' },
        { id: 't4' },
      ])
      s.getState().marqueeSelect(1, 2)
      expect([...s.getState().selectedIds].sort()).toEqual(['t2', 't3'])

      s.getState().setItems([
        { id: 't1' },
        { id: 'tNew' },
        { id: 't3' },
        { id: 't4' },
      ])
      const subscriber = vi.fn()
      const unsubscribe = s.subscribe(subscriber)
      s.getState().marqueeSelect(1, 2)

      expect(subscriber).toHaveBeenCalledOnce()
      expect([...s.getState().selectedIds].sort()).toEqual(['t3', 'tNew'])
      unsubscribe()
    })

    it('marqueeEnd records lastAction by id so it survives reorder', () => {
      const s = createSelectionStore<{ id: string }>((t) => t.id)
      s.getState().setItems([
        { id: 't1' },
        { id: 't2' },
        { id: 't3' },
        { id: 't4' },
        { id: 't5' },
      ])
      s.getState().marqueeSelect(1, 3)
      s.getState().marqueeEnd()
      expect(s.getState().lastActionIndex).toBe(3)

      s.getState().setItems([
        { id: 't5' },
        { id: 't4' },
        { id: 't3' },
        { id: 't2' },
        { id: 't1' },
      ])
      expect(s.getState().lastActionIndex).toBe(1)

      s.getState().rangeSelect(3)
      expect([...s.getState().selectedIds].sort()).toEqual(['t2', 't3', 't4'])
    })

    it('shiftMoveFocus extends from id-anchored focus after reorder', () => {
      const s = createSelectionStore<{ id: string }>((t) => t.id)
      s.getState().setItems([
        { id: 't1' },
        { id: 't2' },
        { id: 't3' },
        { id: 't4' },
        { id: 't5' },
      ])
      s.getState().select('t2')

      s.getState().setItems([
        { id: 't5' },
        { id: 't4' },
        { id: 't3' },
        { id: 't2' },
        { id: 't1' },
      ])
      expect(s.getState().focusedIndex).toBe(3)

      s.getState().shiftMoveFocus(1)
      expect(s.getState().focusedIndex).toBe(4)
      expect(s.getState().selectedIds.has('t1')).toBe(true)
    })

    it('clears lastAction (null) when the range anchor task is removed', () => {
      const s = createSelectionStore<{ id: string }>((t) => t.id)
      s.getState().setItems([{ id: 't1' }, { id: 't2' }, { id: 't3' }])
      s.getState().select('t1')
      expect(s.getState().lastActionIndex).toBe(0)

      s.getState().setItems([{ id: 't2' }, { id: 't3' }])
      expect(s.getState().lastActionIndex).toBeNull()
    })
  })
})
