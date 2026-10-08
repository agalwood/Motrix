import '@test-utils/dom-animations'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import type { LegacyImportReport } from '@shared/schemas/legacy-import'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ImportRunProgress, ImportRunResult } from './import-run-content'

const report: LegacyImportReport = {
  runId: '33333333-3333-4333-8333-333333333333',
  stage: 'committing',
  processed: 1,
  total: 3,
  imported: 1,
  backupCreated: true,
  items: ['imported', 'failed', 'unprocessed', 'skipped'].map(
    (outcome, index) => ({
      itemId: String(index),
      name: `${index}.zip`,
      type: 'http',
      selectable: true,
      reason: outcome === 'skipped' ? 'not-selected' : 'commit-failed',
      outcome: outcome as LegacyImportReport['items'][number]['outcome'],
      taskId: index === 0 ? 'new' : null,
    })
  ),
}

describe('migration run feedback', () => {
  it('does not invent a percentage while preparing the backup', () => {
    render(<ImportRunProgress report={null} />)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    expect(screen.getByText('Waiting for the backup')).toBeVisible()
    expect(screen.queryByText('Backup saved')).not.toBeInTheDocument()
  })

  it('keeps the empty fill initialized while backup changes to a determinate run', () => {
    const view = render(<ImportRunProgress report={null} />)
    const progress = screen.getByRole('progressbar')
    const fill = progress.querySelector('.migration-progress-fill')
    expect(fill).toBeInTheDocument()
    expect(progress.style.getPropertyValue('--migration-progress')).toBe('0')
    expect(fill).toHaveClass('animate-none')
    view.rerender(
      <ImportRunProgress report={{ ...report, processed: 0, imported: 0 }} />
    )
    expect(progress.querySelector('.migration-progress-fill')).toBe(fill)
    expect(progress.style.getPropertyValue('--migration-progress')).toBe('0')
    expect(progress).toHaveAttribute('aria-valuenow', '0')
    view.rerender(<ImportRunProgress report={report} />)
    expect(progress.style.getPropertyValue('--migration-progress')).toBe(
      String(1 / 3)
    )
  })

  it('uses actual processed work, rather than imported work, for progress', () => {
    render(<ImportRunProgress report={{ ...report, processed: 2 }} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      String((2 / 3) * 100)
    )
    expect(screen.getByText('2 / 3 processed')).toBeVisible()
    expect(screen.getByText('Backup saved')).toBeVisible()
    expect(screen.getByText('Add downloads').closest('li')).toHaveAttribute(
      'aria-current',
      'step'
    )
  })

  it('summarizes unfinished work without counting unselected tasks', () => {
    render(
      <ImportRunResult
        report={{ ...report, stage: 'completed' }}
        busy={false}
        exportReport={() => {}}
      />
    )
    expect(
      screen.getByRole('heading', { name: 'Migration is incomplete' })
    ).toBeVisible()
    const summary = screen.getByLabelText('Migration summary')
    expect(within(summary).getByText('1 task')).toBeVisible()
    expect(within(summary).getByText('2 tasks')).toBeVisible()
    expect(within(summary).queryByText('Skipped')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Imported tasks are paused. You can retry the remaining tasks or view your downloads.'
      )
    ).toBeVisible()
  })

  it('does not describe paused downloads when nothing was imported', () => {
    render(
      <ImportRunResult
        report={{ ...report, stage: 'cancelled', imported: 0 }}
        busy={false}
        exportReport={() => {}}
      />
    )
    expect(
      screen.getByRole('heading', { name: 'Migration stopped' })
    ).toBeVisible()
    expect(
      screen.getByText(
        'No tasks were added. You can try again when you’re ready.'
      )
    ).toBeVisible()
    expect(
      screen.queryByText(/Imported tasks are paused/)
    ).not.toBeInTheDocument()
  })
})
