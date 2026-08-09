import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createSelectionStore } from '../selection/create-selection-store'
import { useSelectableList } from './use-selectable-list'

interface TestItem {
  id: string
  name: string
}

const makeItems = (count: number): TestItem[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    name: `Item ${i}`,
  }))

function TestHarness({ items }: { items: TestItem[] }) {
  const { getRowProps, headerCheckbox, onKeyDown } = useSelectableList({
    items,
    getId: (t) => t.id,
    rowHeight: 40,
  })

  return (
    <div
      role="listbox"
      onKeyDown={onKeyDown}
      tabIndex={0}
      data-testid="wrapper"
    >
      <label data-testid="header-checkbox">
        <input
          type="checkbox"
          checked={headerCheckbox.checked}
          ref={(el) => {
            if (el) el.indeterminate = headerCheckbox.indeterminate
          }}
          onChange={headerCheckbox.onChange}
        />
      </label>
      <div data-testid="list-area">
        {items.map((item, index) => {
          const rowProps = getRowProps(index)
          return (
            <div
              key={item.id}
              role="option"
              aria-selected={rowProps.selected}
              tabIndex={-1}
              data-testid={`row-${index}`}
              data-selected={rowProps.selected}
              data-focused={rowProps.focused}
              onClick={rowProps.onClick}
              onKeyDown={() => {}}
            >
              <input
                type="checkbox"
                data-testid={`checkbox-${index}`}
                checked={rowProps.selected}
                onChange={() => {}}
                onClick={(e) => {
                  e.stopPropagation()
                  rowProps.onCheckboxChange()
                }}
              />
              {item.name}
            </div>
          )
        })}
      </div>
    </div>
  )
}

describe('useSelectableList', () => {
  describe('click selection', () => {
    it('single click selects one row and clears others', () => {
      render(<TestHarness items={makeItems(5)} />)

      fireEvent.click(screen.getByTestId('row-2'))
      expect(screen.getByTestId('row-2').dataset.selected).toBe('true')
      expect(screen.getByTestId('row-0').dataset.selected).toBe('false')
    })

    it('ctrl+click toggles without clearing', () => {
      render(<TestHarness items={makeItems(5)} />)

      fireEvent.click(screen.getByTestId('row-1'))
      fireEvent.click(screen.getByTestId('row-3'), { ctrlKey: true })

      expect(screen.getByTestId('row-1').dataset.selected).toBe('true')
      expect(screen.getByTestId('row-3').dataset.selected).toBe('true')
    })

    it('meta+click toggles without clearing (macOS)', () => {
      render(<TestHarness items={makeItems(5)} />)

      fireEvent.click(screen.getByTestId('row-1'))
      fireEvent.click(screen.getByTestId('row-3'), { metaKey: true })

      expect(screen.getByTestId('row-1').dataset.selected).toBe('true')
      expect(screen.getByTestId('row-3').dataset.selected).toBe('true')
    })

    it('shift+click selects range', () => {
      render(<TestHarness items={makeItems(5)} />)

      fireEvent.click(screen.getByTestId('row-1'))
      fireEvent.click(screen.getByTestId('row-3'), { shiftKey: true })

      expect(screen.getByTestId('row-1').dataset.selected).toBe('true')
      expect(screen.getByTestId('row-2').dataset.selected).toBe('true')
      expect(screen.getByTestId('row-3').dataset.selected).toBe('true')
    })
  })

  describe('checkbox', () => {
    it('checkbox toggles without affecting others', () => {
      render(<TestHarness items={makeItems(5)} />)

      fireEvent.click(screen.getByTestId('row-0'))
      fireEvent.click(screen.getByTestId('checkbox-2'))

      expect(screen.getByTestId('row-0').dataset.selected).toBe('true')
      expect(screen.getByTestId('row-2').dataset.selected).toBe('true')
    })
  })

  describe('header checkbox', () => {
    it('selects all when none selected', () => {
      render(<TestHarness items={makeItems(3)} />)

      const headerCb = screen
        .getByTestId('header-checkbox')
        .querySelector('input') as HTMLInputElement
      fireEvent.click(headerCb)

      expect(screen.getByTestId('row-0').dataset.selected).toBe('true')
      expect(screen.getByTestId('row-1').dataset.selected).toBe('true')
      expect(screen.getByTestId('row-2').dataset.selected).toBe('true')
    })

    it('clears all when all selected', () => {
      render(<TestHarness items={makeItems(3)} />)

      const headerCb = screen
        .getByTestId('header-checkbox')
        .querySelector('input') as HTMLInputElement
      fireEvent.click(headerCb) // select all
      fireEvent.click(headerCb) // deselect all

      expect(screen.getByTestId('row-0').dataset.selected).toBe('false')
    })
  })

  describe('keyboard', () => {
    it('arrow down moves focus', () => {
      render(<TestHarness items={makeItems(5)} />)

      const wrapper = screen.getByTestId('wrapper')
      fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
      expect(screen.getByTestId('row-0').dataset.focused).toBe('true')

      fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
      expect(screen.getByTestId('row-1').dataset.focused).toBe('true')
      expect(screen.getByTestId('row-0').dataset.focused).toBe('false')
    })

    it('space toggles focused row selection', () => {
      render(<TestHarness items={makeItems(5)} />)

      const wrapper = screen.getByTestId('wrapper')
      fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
      fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
      fireEvent.keyDown(wrapper, { key: ' ' })

      expect(screen.getByTestId('row-1').dataset.selected).toBe('true')
    })

    it('ctrl+a selects all', () => {
      render(<TestHarness items={makeItems(3)} />)

      const wrapper = screen.getByTestId('wrapper')
      fireEvent.keyDown(wrapper, { key: 'a', ctrlKey: true })

      expect(screen.getByTestId('row-0').dataset.selected).toBe('true')
      expect(screen.getByTestId('row-1').dataset.selected).toBe('true')
      expect(screen.getByTestId('row-2').dataset.selected).toBe('true')
    })

    it('escape clears selection', () => {
      render(<TestHarness items={makeItems(3)} />)

      fireEvent.click(screen.getByTestId('row-0'))
      const wrapper = screen.getByTestId('wrapper')
      fireEvent.keyDown(wrapper, { key: 'Escape' })

      expect(screen.getByTestId('row-0').dataset.selected).toBe('false')
    })

    it('shift+arrow extends selection', () => {
      render(<TestHarness items={makeItems(5)} />)

      const wrapper = screen.getByTestId('wrapper')
      fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
      fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
      fireEvent.keyDown(wrapper, { key: ' ' })
      fireEvent.keyDown(wrapper, { key: 'ArrowDown', shiftKey: true })
      fireEvent.keyDown(wrapper, { key: 'ArrowDown', shiftKey: true })

      expect(screen.getByTestId('row-1').dataset.selected).toBe('true')
      expect(screen.getByTestId('row-2').dataset.selected).toBe('true')
      expect(screen.getByTestId('row-3').dataset.selected).toBe('true')
    })
  })
})

describe('useSelectableList (external store)', () => {
  interface Item {
    id: string
  }

  it('uses an externally provided store instead of creating an internal one', () => {
    const external = createSelectionStore<Item>((x) => x.id)
    external.getState().setItems([{ id: 'a' }, { id: 'b' }])
    external.getState().select('a')

    const { result } = renderHook(() =>
      useSelectableList({
        items: [{ id: 'a' }, { id: 'b' }],
        getId: (x: Item) => x.id,
        rowHeight: 20,
        headerHeight: 0,
        store: external,
      })
    )

    expect(result.current.selection).toBe(external)
    expect(external.getState().selectedIds.has('a')).toBe(true)
  })

  it('falls back to an internal store when no store prop is given', () => {
    const { result } = renderHook(() =>
      useSelectableList({
        items: [{ id: 'a' }, { id: 'b' }],
        getId: (x: Item) => x.id,
        rowHeight: 20,
        headerHeight: 0,
      })
    )

    expect(result.current.selection).toBeDefined()
    expect(typeof result.current.selection.getState).toBe('function')
    // Internal store starts with empty selection
    expect(result.current.selection.getState().selectedIds.size).toBe(0)
  })

  it('external store state mutations propagate through the hook return', () => {
    const external = createSelectionStore<Item>((x) => x.id)
    external.getState().setItems([{ id: 'a' }, { id: 'b' }])

    const { result } = renderHook(() =>
      useSelectableList({
        items: [{ id: 'a' }, { id: 'b' }],
        getId: (x: Item) => x.id,
        rowHeight: 20,
        headerHeight: 0,
        store: external,
      })
    )

    // Mutate via external handle, observe via hook return
    external.getState().toggle('b')
    expect(result.current.selection.getState().selectedIds.has('b')).toBe(true)
  })
})
