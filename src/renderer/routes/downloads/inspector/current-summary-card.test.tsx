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
})
