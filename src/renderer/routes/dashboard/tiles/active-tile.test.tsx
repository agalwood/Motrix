import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { TaskStatus } from '@shared/types/task'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { dashboardTileViewport } from '../layout/dashboard-registry'

vi.mock('@renderer/hooks/use-task-list', () => ({
  useTaskList: () => ({
    tasks: [
      { id: '1', status: TaskStatus.Downloading },
      { id: '2', status: TaskStatus.Downloading },
      { id: '3', status: TaskStatus.Seeding },
      { id: '4', status: TaskStatus.Queued },
      { id: '5', status: TaskStatus.FetchingMetadata },
      { id: '6', status: TaskStatus.Error },
    ],
  }),
}))

const { ActiveTile } = await import('./active-tile')

const compactViewport = dashboardTileViewport('active', { w: 1, h: 1 })
const summaryViewport = dashboardTileViewport('active', { w: 2, h: 1 })
const detailedViewport = dashboardTileViewport('active', { w: 2, h: 2 })
const focusViewport = dashboardTileViewport('active', { w: 4, h: 1 })

describe('ActiveTile', () => {
  it('keeps the primary count above the breakdown in summary', () => {
    render(<ActiveTile activeCount={4} viewport={summaryViewport} />)
    // Aggregates surfaced in the tile: Downloading=2, Waiting=2, Seeding=1
    expect(screen.getByText('4')).toBeInTheDocument() // primary KPI
    expect(screen.getByText(/Downloading|下载中/i)).toBeInTheDocument()
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/Waiting|等待/i)).toBeInTheDocument()
    expect(screen.getByText(/Seeding|做种/i)).toBeInTheDocument()
    expect(screen.queryByText(/Error|错误/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('active-breakdown')).toHaveClass('grid-cols-3')
    const content = screen.getByTestId('active-content')
    expect(content).toHaveClass('flex-col', 'justify-between')
    expect(content).not.toHaveClass('items-end')
    expect(content.firstElementChild).toHaveTextContent('4')
    expect(content.lastElementChild).toBe(
      screen.getByTestId('active-breakdown')
    )
  })

  it('renders only the primary count in compact content', () => {
    render(<ActiveTile activeCount={4} viewport={compactViewport} />)
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.queryByText(/Downloading|下载中/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('active-breakdown')).not.toBeInTheDocument()
  })

  it('shows every status bucket in a square detailed viewport', () => {
    render(<ActiveTile activeCount={4} viewport={detailedViewport} />)
    expect(screen.getByText(/Error|错误/i)).toBeInTheDocument()
    expect(screen.getByTestId('active-breakdown')).toHaveClass(
      'grid-cols-2',
      'gap-y-4'
    )
    expect(screen.getByTestId('active-content')).toHaveClass('flex-col')
  })

  it('keeps the KPI above a four-column breakdown in focus content', () => {
    render(<ActiveTile activeCount={4} viewport={focusViewport} />)

    expect(screen.getByText(/Error|错误/i)).toBeInTheDocument()
    expect(screen.getByTestId('active-breakdown')).toHaveClass('grid-cols-4')
    expect(screen.getByTestId('active-content')).toHaveClass(
      'flex-col',
      'justify-between'
    )
  })
})
