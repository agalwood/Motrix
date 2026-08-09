import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { makeDownloadTask } from '@test-utils/task'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CurrentSummaryCard } from './current-summary-card'

describe('CurrentSummaryCard', () => {
  it('shows live directions and only Average, Peak, and Active lifetime rows', () => {
    render(
      <CurrentSummaryCard
        task={makeDownloadTask({
          downloadSpeed: 2_048,
          uploadSpeed: 1_024,
        })}
        lifetime={{
          points: [],
          averageDownloadSpeed: 3_072,
          peakDownloadSpeed: 4_096,
          peakUploadSpeed: 2_048,
          activeMs: 42_000,
          updatedAt: 1_000,
          accuracy: 'estimated',
        }}
      />
    )

    expect(screen.getByText('2.0 KB/s')).toBeInTheDocument()
    expect(screen.getByText('1.0 KB/s')).toBeInTheDocument()
    expect(screen.getByText('3.0 KB/s')).toBeInTheDocument()
    expect(screen.getByText('4.0 KB/s')).toBeInTheDocument()
    expect(screen.getByText('00:42')).toBeInTheDocument()
    expect(screen.queryByText(/Progress/i)).toBeNull()
    expect(screen.queryByText(/ETA/i)).toBeNull()
  })

  it('keeps both live speeds complete in the narrow two-column card', () => {
    render(
      <CurrentSummaryCard
        task={makeDownloadTask({
          downloadSpeed: 384 * 1_024,
          uploadSpeed: 72 * 1_024,
        })}
        lifetime={null}
      />
    )

    const download = screen.getByText('384 KB/s')
    const upload = screen.getByText('72.0 KB/s')
    expect(download).toHaveClass('whitespace-nowrap', 'text-base')
    expect(upload).toHaveClass('whitespace-nowrap')
    expect(download).not.toHaveClass('truncate')
    expect(upload).not.toHaveClass('truncate')
    const summary = screen.getByTestId('task-inspector-activity-summary-card')
    expect(summary).toHaveClass('@container/summary', 'border-y', 'py-3')
    expect(summary).not.toHaveClass('rounded-md', 'border')
    expect(
      screen.getByTestId('task-inspector-activity-summary-secondary')
    ).toHaveClass('divide-x')
  })
})
