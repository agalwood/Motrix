import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { TransferStatsState } from '@renderer/hooks/use-transfer-stats'
import type { TransferStatsSnapshot } from '@shared/types/stats'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dashboardTileViewport } from '../layout/dashboard-registry'
import { TransferTile } from './transfer-tile'

const DAY_START = new Date(2026, 6, 26, 0, 0, 0, 0).getTime()
const MIB = 1024 * 1024
const GIB = 1024 * MIB

const snapshot: TransferStatsSnapshot = {
  today: {
    downloadBytes: String(738 * MIB),
    uploadBytes: String(222 * MIB),
    totalBytes: String(960 * MIB),
    startedAt: DAY_START,
    endsAt: new Date(2026, 6, 27, 0, 0, 0, 0).getTime(),
    coverageStartedAt: DAY_START,
  },
  allTime: {
    downloadBytes: String(2 * GIB),
    uploadBytes: String(GIB),
    totalBytes: String(3 * GIB),
    startedAt: new Date(2026, 0, 2, 0, 0, 0, 0).getTime(),
    coverageStartedAt: new Date(2026, 0, 2, 0, 0, 0, 0).getTime(),
  },
  updatedAt: new Date(2026, 6, 26, 10, 30, 0, 0).getTime(),
  accuracy: 'estimated',
}

const readyState: TransferStatsState = {
  status: 'ready',
  snapshot,
  retry: vi.fn(),
}

function renderTile({
  span = { w: 2, h: 1 },
  state = readyState,
}: {
  span?: { w: 1 | 2 | 4; h: 1 | 2 }
  state?: TransferStatsState
} = {}) {
  return render(
    <TransferTile
      state={state}
      viewport={dashboardTileViewport('transfer', span)}
    />
  )
}

afterEach(async () => {
  await i18n.changeLanguage('en-US')
})

describe('TransferTile', () => {
  it('defaults to Today and switches scope without fetching', async () => {
    const user = userEvent.setup()
    renderTile()

    expect(
      screen.getByRole('radiogroup', { name: 'Transfer range' })
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Today' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByTestId('transfer-total')).toHaveTextContent('960 MB')
    expect(screen.getByTestId('transfer-total').firstElementChild).toHaveClass(
      'h-8',
      'text-[32px]',
      'leading-none'
    )
    expect(
      screen.getByTestId('transfer-total').firstElementChild
    ).not.toHaveClass('leading-none!')
    expect(screen.getByRole('radio', { name: 'Today' })).toHaveClass(
      'h-5',
      'rounded-md!',
      'px-2'
    )
    expect(screen.getByRole('radio', { name: 'All Time' })).toHaveClass(
      'h-5',
      'rounded-md!',
      'px-2'
    )

    await user.click(screen.getByRole('radio', { name: 'All Time' }))

    expect(screen.getByRole('radio', { name: 'All Time' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByTestId('transfer-total')).toHaveTextContent('3.0 GB')
  })

  it('uses shared roving radio keyboard behavior outside width 1', async () => {
    const user = userEvent.setup()
    renderTile()

    const today = screen.getByRole('radio', { name: 'Today' })
    const allTime = screen.getByRole('radio', { name: 'All Time' })
    expect(today).toHaveAttribute('tabindex', '0')
    expect(allTime).toHaveAttribute('tabindex', '-1')

    today.focus()
    await user.keyboard('{ArrowRight}')

    expect(allTime).toHaveFocus()
    expect(allTime).toHaveAttribute('aria-checked', 'true')
    expect(allTime).toHaveAttribute('tabindex', '0')
    expect(today).toHaveAttribute('tabindex', '-1')
    expect(screen.getByTestId('transfer-total')).toHaveTextContent('3.0 GB')
  })

  it('uses a complete-label body dropdown at width 1 and no color bar', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { container } = renderTile({ span: { w: 1, h: 1 } })

    const trigger = screen.getByRole('button', {
      name: 'Transfer range: Today',
    })
    expect(trigger).toHaveTextContent('Today')
    expect(container.querySelector('header')?.contains(trigger)).toBe(false)
    expect(screen.queryByTestId('transfer-directions')).toBeNull()
    expect(screen.queryByTestId('transfer-proportion-bar')).toBeNull()
    expect(
      screen.getByRole('region', {
        name: 'Today transfer total: 960 MB',
      })
    ).toBeInTheDocument()

    await user.click(trigger)
    await user.click(
      await screen.findByRole('menuitemradio', { name: 'All Time' })
    )

    expect(
      screen.getByRole('button', { name: 'Transfer range: All Time' })
    ).toHaveTextContent('All Time')
    expect(screen.getByTestId('transfer-total')).toHaveTextContent('3.0 GB')
  })

  it('renders ordered transfer endpoints with proportional segments', () => {
    renderTile()

    const labels = screen.getByTestId('transfer-direction-labels')
    const values = screen.getByTestId('transfer-direction-values')
    const bar = screen.getByTestId('transfer-proportion-bar')
    const upload = screen.getByTestId('transfer-upload-segment')
    const download = screen.getByTestId('transfer-download-segment')

    expect(labels).toHaveTextContent(/Up.*Down/)
    expect(labels.compareDocumentPosition(values)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(values.compareDocumentPosition(bar)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(bar).toHaveAttribute('aria-hidden')
    expect(upload.compareDocumentPosition(download)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(upload).toHaveStyle({ width: '23.12%' })
    expect(download).toHaveStyle({ width: '76.88%' })
  })

  it('keeps labels separate from values when one direction is zero', () => {
    const downloadBytes = String(Math.round(53.3 * MIB))
    const oneDirectionSnapshot: TransferStatsSnapshot = {
      ...snapshot,
      today: {
        ...snapshot.today,
        downloadBytes,
        uploadBytes: '0',
        totalBytes: downloadBytes,
      },
    }

    renderTile({
      state: {
        status: 'ready',
        snapshot: oneDirectionSnapshot,
        retry: vi.fn(),
      },
    })

    const labels = screen.getByTestId('transfer-direction-labels')
    const values = screen.getByTestId('transfer-direction-values')
    const [uploadValue, downloadValue] = Array.from(values.children)

    expect(labels).toHaveTextContent('UpDown')
    expect(labels).not.toHaveTextContent(/0 B|53\.3 MB/)
    expect(values).not.toHaveTextContent(/Up|Down/)
    expect(uploadValue).toHaveTextContent('0 B')
    expect(downloadValue).toHaveTextContent('53.3 MB')
    expect(screen.queryByTestId('transfer-upload-segment')).toBeNull()
    expect(screen.getByTestId('transfer-download-segment')).toHaveStyle({
      width: '100%',
    })
  })

  it('keeps the focus presentation in strict vertical reading order', () => {
    renderTile({ span: { w: 4, h: 1 } })

    const content = screen.getByTestId('transfer-content')
    const total = screen.getByTestId('transfer-total')
    const chart = screen.getByTestId('transfer-chart')
    const directions = screen.getByTestId('transfer-directions')
    const bar = screen.getByTestId('transfer-proportion-bar')

    expect(content).toHaveClass('flex-col', 'gap-1')
    expect(content).toHaveAttribute('data-presentation', '4x1')
    expect(total.compareDocumentPosition(chart)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(directions.compareDocumentPosition(bar)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(content.className).not.toContain('focusHorizontal')
  })

  it('keeps scope switching, stacked directions, and coverage in 1x2', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const partialSnapshot: TransferStatsSnapshot = {
      ...snapshot,
      today: {
        ...snapshot.today,
        coverageStartedAt: DAY_START + 14 * 60 * 60 * 1000,
      },
    }
    renderTile({
      span: { w: 1, h: 2 },
      state: {
        status: 'ready',
        snapshot: partialSnapshot,
        retry: vi.fn(),
      },
    })

    const tile = document.querySelector('.dashboard-tile')
    const trigger = screen.getByRole('button', {
      name: 'Transfer range: Today',
    })
    const total = screen.getByTestId('transfer-total')

    expect(tile).toHaveClass('gap-0')
    expect(trigger.compareDocumentPosition(total)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(screen.getByTestId('transfer-directions')).toHaveClass(
      'grid',
      'gap-3'
    )
    expect(
      screen.getByTestId('transfer-directions').querySelector('.mt-1')
    ).not.toBeNull()
    expect(screen.getByText(/Since 2:00 PM/i)).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Transfer range: Today' })
    )
    await user.click(
      await screen.findByRole('menuitemradio', { name: 'All Time' })
    )

    expect(
      screen.getByRole('button', { name: 'Transfer range: All Time' })
    ).toBeInTheDocument()
    expect(screen.getByTestId('transfer-total')).toHaveTextContent('3.0 GB')
    expect(screen.getByText(/Since 1\/2\/26/i)).toBeInTheDocument()
  })

  it('omits the bar and shows scope-specific copy for empty data', async () => {
    const user = userEvent.setup()
    const emptySnapshot: TransferStatsSnapshot = {
      ...snapshot,
      today: {
        ...snapshot.today,
        downloadBytes: '0',
        uploadBytes: '0',
        totalBytes: '0',
      },
      allTime: {
        ...snapshot.allTime,
        downloadBytes: '0',
        uploadBytes: '0',
        totalBytes: '0',
      },
    }
    renderTile({
      state: {
        status: 'ready',
        snapshot: emptySnapshot,
        retry: vi.fn(),
      },
    })

    expect(screen.getByTestId('transfer-total')).toHaveTextContent('0 B')
    expect(screen.getByText('No transfer recorded today.')).toBeInTheDocument()
    expect(screen.queryByTestId('transfer-proportion-bar')).toBeNull()

    await user.click(screen.getByRole('radio', { name: 'All Time' }))
    expect(screen.getByText('No transfer recorded yet.')).toBeInTheDocument()
  })

  it('keeps detailed zero states empty instead of replacing them with coverage', () => {
    const emptySnapshot: TransferStatsSnapshot = {
      ...snapshot,
      today: {
        ...snapshot.today,
        downloadBytes: '0',
        uploadBytes: '0',
        totalBytes: '0',
        coverageStartedAt: DAY_START + 14 * 60 * 60 * 1000,
      },
    }

    renderTile({
      span: { w: 1, h: 2 },
      state: {
        status: 'ready',
        snapshot: emptySnapshot,
        retry: vi.fn(),
      },
    })

    expect(screen.getByText('No transfer recorded today.')).toBeInTheDocument()
    expect(screen.queryByText(/Since 2:00 PM/i)).toBeNull()
  })

  it('never presents loading or unavailable data as zero and retries', async () => {
    const user = userEvent.setup()
    const retry = vi.fn()
    const { container, rerender } = render(
      <TransferTile
        state={{ status: 'loading', retry }}
        viewport={dashboardTileViewport('transfer', { w: 2, h: 1 })}
      />
    )

    expect(screen.getByText('Loading transfer data')).toBeInTheDocument()
    expect(screen.queryByText('0 B')).toBeNull()
    expect(container.querySelector('.dashboard-tile')).toHaveClass('gap-0')

    rerender(
      <TransferTile
        state={{ status: 'unavailable', retry }}
        viewport={dashboardTileViewport('transfer', { w: 2, h: 1 })}
      />
    )
    expect(screen.getByText('Transfer data unavailable')).toBeInTheDocument()
    expect(screen.queryByText('0 B')).toBeNull()
    expect(container.querySelector('.dashboard-tile')).toHaveClass('gap-0')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('keeps stale values without showing an engine pause caption', () => {
    const retry = vi.fn()
    const { rerender } = render(
      <TransferTile
        state={{ status: 'stale', snapshot, retry }}
        viewport={dashboardTileViewport('transfer', { w: 2, h: 1 })}
      />
    )

    expect(screen.getByTestId('transfer-total')).toHaveTextContent('960 MB')
    expect(screen.getByText(/Updated 10:30 AM/i)).toBeInTheDocument()

    rerender(
      <TransferTile
        state={{ status: 'ready', snapshot, retry }}
        viewport={dashboardTileViewport('transfer', { w: 2, h: 1 })}
      />
    )
    expect(screen.queryByText('Updates paused')).toBeNull()
  })

  it('uses an honest generic stale caption when no update timestamp exists', () => {
    renderTile({
      state: {
        status: 'stale',
        snapshot: { ...snapshot, updatedAt: null },
        retry: vi.fn(),
      },
    })

    expect(screen.getByText('Data may be out of date')).toHaveAttribute(
      'role',
      'status'
    )
    expect(screen.queryByText(/Updated/i)).toBeNull()
  })

  it('keeps compact Chinese scope text complete', async () => {
    await i18n.changeLanguage('zh-CN')
    renderTile({ span: { w: 1, h: 1 } })

    expect(
      screen.getByRole('button', { name: '传输范围: 今日' })
    ).toHaveTextContent('今日')
    expect(screen.getByText('传输')).toBeInTheDocument()
  })

  it('keeps Chinese direction endpoints on their own row', async () => {
    await i18n.changeLanguage('zh-CN')
    renderTile()

    expect(screen.getByTestId('transfer-direction-labels')).toHaveTextContent(
      '上传下载'
    )
    expect(
      screen.getByTestId('transfer-direction-values')
    ).not.toHaveTextContent(/上传|下载/)
  })
})
