import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { TaskPiecesResult } from '@shared/types/pieces'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockPieces = vi.hoisted(() => ({
  value: {
    pieceLength: 1024,
    numPieces: 8,
    bitfield: 'ff',
  } as TaskPiecesResult | null,
}))

vi.mock('@renderer/hooks/use-task-pieces', () => ({
  useTaskPieces: () => ({ pieces: mockPieces.value }),
}))

import { PiecesTab } from './pieces-tab'

// Tests mock useTaskPieces; PiecesTab only reads task.id and task.status.
const makeTask = (id: string, status = TaskStatus.Downloading) =>
  makeDownloadTask({ id, status })

describe('PiecesTab', () => {
  it('renders a single canvas exposing the piece count', () => {
    mockPieces.value = { pieceLength: 1024, numPieces: 8, bitfield: 'ff' }
    const { container } = render(<PiecesTab task={makeTask('t-1')} />)
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas?.getAttribute('data-piece-count')).toBe('8')
  })

  it('locks direction to LTR for piece ordering', () => {
    mockPieces.value = { pieceLength: 1024, numPieces: 8, bitfield: 'ff' }
    const { container } = render(<PiecesTab task={makeTask('t-1')} />)
    const root = container.querySelector('[data-testid=pieces-root]')
    expect(root?.getAttribute('dir')).toBe('ltr')
  })

  it('renders full-complete canvas for synthesized completed pieces', () => {
    mockPieces.value = { pieceLength: 16384, numPieces: 5, bitfield: 'ff' }
    const { container } = render(
      <PiecesTab task={makeTask('t-evicted', TaskStatus.Completed)} />
    )
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas?.getAttribute('data-piece-count')).toBe('5')
  })

  it('renders the empty state when no trustworthy piece map remains', () => {
    mockPieces.value = { pieceLength: 0, numPieces: 0, bitfield: '' }
    const { container } = render(
      <PiecesTab task={makeTask('t-error', TaskStatus.Error)} />
    )

    expect(container.querySelector('canvas')).toBeNull()
    expect(container.textContent).toContain('No pieces data')
  })

  it('keeps loading-shaped placeholder when pieces=null on a live status', () => {
    mockPieces.value = null
    const { container } = render(
      <PiecesTab task={makeTask('t-loading', TaskStatus.Downloading)} />
    )
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })
})
