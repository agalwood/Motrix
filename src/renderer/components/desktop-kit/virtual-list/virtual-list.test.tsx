import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
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
})
