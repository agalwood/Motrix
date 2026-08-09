import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDragDepth } from './use-drag-depth'

function Harness({ onFilesDrop }: { onFilesDrop?: (files: FileList) => void }) {
  const { isDragging, dragHandlers } = useDragDepth<HTMLDivElement>(onFilesDrop)
  return (
    <div data-testid="root" data-dragging={isDragging} {...dragHandlers}>
      <div data-testid="child" />
    </div>
  )
}

describe('useDragDepth', () => {
  it('starts not dragging', () => {
    const { getByTestId } = render(<Harness />)
    expect(getByTestId('root').dataset.dragging).toBe('false')
  })

  it('enters dragging on first dragenter', () => {
    const { getByTestId } = render(<Harness />)
    act(() => {
      fireEvent.dragEnter(getByTestId('root'))
    })
    expect(getByTestId('root').dataset.dragging).toBe('true')
  })

  it('stays dragging when entering a nested child', () => {
    const { getByTestId } = render(<Harness />)
    act(() => {
      fireEvent.dragEnter(getByTestId('root'))
      fireEvent.dragEnter(getByTestId('child'))
      fireEvent.dragLeave(getByTestId('child'))
    })
    expect(getByTestId('root').dataset.dragging).toBe('true')
  })

  it('exits dragging only after counter reaches zero', () => {
    const { getByTestId } = render(<Harness />)
    act(() => {
      fireEvent.dragEnter(getByTestId('root'))
      fireEvent.dragEnter(getByTestId('child'))
      fireEvent.dragLeave(getByTestId('child'))
      fireEvent.dragLeave(getByTestId('root'))
    })
    expect(getByTestId('root').dataset.dragging).toBe('false')
  })

  it('invokes onFilesDrop with dropped files and resets state', () => {
    const onFilesDrop = vi.fn()
    const { getByTestId } = render(<Harness onFilesDrop={onFilesDrop} />)
    const file = new File(['x'], 'x.torrent', {
      type: 'application/x-bittorrent',
    })
    act(() => {
      fireEvent.dragEnter(getByTestId('root'))
      fireEvent.drop(getByTestId('root'), { dataTransfer: { files: [file] } })
    })
    expect(onFilesDrop).toHaveBeenCalledTimes(1)
    expect(getByTestId('root').dataset.dragging).toBe('false')
  })

  it('ignores empty drops (no files)', () => {
    const onFilesDrop = vi.fn()
    const { getByTestId } = render(<Harness onFilesDrop={onFilesDrop} />)
    act(() => {
      fireEvent.dragEnter(getByTestId('root'))
      fireEvent.drop(getByTestId('root'), { dataTransfer: { files: [] } })
    })
    expect(onFilesDrop).not.toHaveBeenCalled()
  })
})
