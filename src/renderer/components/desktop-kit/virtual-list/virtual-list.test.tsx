import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { VirtualListHandle } from './types'
import { VirtualList } from './virtual-list'

interface TestItem {
  id: string
  label: string
}

const makeItems = (count: number): TestItem[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    label: `Label ${i}`,
  }))

describe('VirtualList', () => {
  it('renders renderEmpty when items is empty', () => {
    render(
      <VirtualList<TestItem>
        items={[]}
        getId={(item) => item.id}
        rowHeight={40}
        renderRow={({ item }) => <div>{item.label}</div>}
        renderEmpty={() => <div data-testid="empty">No items</div>}
      />
    )
    expect(screen.getByTestId('empty')).toBeDefined()
  })

  it('renders renderHeader when provided', () => {
    render(
      <VirtualList<TestItem>
        items={makeItems(5)}
        getId={(item) => item.id}
        rowHeight={40}
        renderRow={({ item }) => <div>{item.label}</div>}
        renderHeader={() => <div data-testid="header">Header</div>}
      />
    )
    expect(screen.getByTestId('header')).toBeDefined()
  })

  it('exposes handle via ref', () => {
    const ref = createRef<VirtualListHandle>()
    render(
      <VirtualList<TestItem>
        ref={ref}
        items={makeItems(10)}
        getId={(item) => item.id}
        rowHeight={40}
        renderRow={({ item }) => <div>{item.label}</div>}
      />
    )
    expect(ref.current).not.toBeNull()
    expect(typeof ref.current?.scrollToIndex).toBe('function')
    expect(typeof ref.current?.getScrollOffset).toBe('function')
    expect(typeof ref.current?.getContainerRef).toBe('function')
  })

  it('renders the scroll container div', () => {
    const { container } = render(
      <VirtualList<TestItem>
        items={makeItems(100)}
        getId={(item) => item.id}
        rowHeight={40}
        renderRow={({ item }) => <div>{item.label}</div>}
      />
    )
    const scrollContainer = container.querySelector(
      '[data-testid="virtual-list-container"]'
    )
    expect(scrollContainer).not.toBeNull()
  })

  it.each(['native', 'custom'] as const)(
    'retains active options and viewport semantics with %s scrollbars',
    (scrollbar) => {
      const height = vi
        .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
        .mockReturnValue(200)
      const width = vi
        .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
        .mockReturnValue(400)
      const { unmount } = render(
        <VirtualList<TestItem>
          items={makeItems(500)}
          getId={(item) => item.id}
          rowHeight={40}
          activeIndex={0}
          keepMountedIndex={499}
          scrollbar={scrollbar}
          containerProps={{
            role: 'listbox',
            tabIndex: 0,
            'aria-activedescendant': 'item-0',
          }}
          renderRow={({ item }) => (
            <div
              role="option"
              tabIndex={-1}
              aria-selected={item.id === 'item-0'}
              id={item.id}
            >
              {item.label}
            </div>
          )}
        />
      )
      const list = screen.getByRole('listbox')
      expect(document.getElementById('item-0')).not.toBeNull()
      expect(document.getElementById('item-499')).not.toBeNull()
      expect(list.tabIndex).toBe(0)
      if (scrollbar === 'custom')
        expect(list.getAttribute('data-slot')).toBe('scroll-area-viewport')
      fireEvent.scroll(list, { target: { scrollTop: 12_000 } })
      expect(document.getElementById('item-0')).not.toBeNull()
      expect(document.getElementById('item-499')).not.toBeNull()
      expect(list.getAttribute('aria-activedescendant')).toBe('item-0')
      expect(screen.getAllByRole('option').length).toBeLessThan(30)
      expect(document.getElementById('item-300')).not.toBeNull()
      unmount()
      height.mockRestore()
      width.mockRestore()
    }
  )
})
