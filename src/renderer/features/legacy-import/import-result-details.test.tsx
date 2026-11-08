import '@test-utils/dom-animations'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import type { LegacyImportReport } from '@shared/schemas/legacy-import'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportResultDetails } from './import-result-details'

const report: LegacyImportReport = {
  runId: '33333333-3333-4333-8333-333333333333',
  stage: 'completed',
  processed: 1,
  total: 1,
  imported: 1,
  backupCreated: true,
  items: [
    {
      itemId: 'one',
      name: 'one.zip',
      type: 'http',
      selectable: true,
      reason: 'fresh-download-required',
      outcome: 'imported',
      taskId: 'new',
    },
  ],
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

describe('migration report details', () => {
  it('mounts the report only on disclosure and exports the unchanged run', () => {
    const exportReport = vi.fn()
    render(
      <ImportResultDetails
        report={report}
        busy={false}
        exportReport={exportReport}
      />
    )
    const disclosure = screen.getByRole('button', { name: 'View details' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('one.zip')).not.toBeInTheDocument()
    fireEvent.click(disclosure)
    expect(screen.getByTitle('one.zip')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Save report…' }))
    expect(exportReport).toHaveBeenCalledOnce()
    fireEvent.click(disclosure)
    expect(screen.queryByTitle('one.zip')).not.toBeInTheDocument()
    expect(report.items[0].outcome).toBe('imported')
  })

  it('prioritizes unfinished tasks and excludes tasks the user did not select', () => {
    const source = {
      ...report,
      items: [
        report.items[0],
        {
          ...report.items[0],
          itemId: 'failed',
          name: 'failed.zip',
          outcome: 'failed' as const,
          reason: 'commit-failed' as const,
        },
        {
          ...report.items[0],
          itemId: 'unselected',
          name: 'unselected.zip',
          outcome: 'skipped' as const,
          reason: 'not-selected' as const,
        },
      ],
    }
    render(
      <ImportResultDetails
        report={source}
        busy={false}
        exportReport={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'View details' }))
    const rows = document.querySelectorAll('[data-import-result]')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('data-import-result', 'failed')
    expect(screen.queryByTitle('unselected.zip')).not.toBeInTheDocument()
    expect(source.items).toHaveLength(3)
    expect(source.items[0].itemId).toBe('one')
  })

  it('virtualizes large reports instead of building every hidden row', () => {
    const large = {
      ...report,
      items: Array.from({ length: 5000 }, (_, index) => ({
        ...report.items[0],
        itemId: `item-${index}`,
        name: `download-${index}.zip`,
      })),
    }
    render(
      <ImportResultDetails
        report={large}
        busy={false}
        exportReport={() => {}}
      />
    )
    expect(document.querySelectorAll('[data-import-result]')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'View details' }))
    expect(screen.getByTestId('virtual-list-container')).toBeInTheDocument()
    expect(
      document.querySelectorAll('[data-import-result]').length
    ).toBeLessThan(100)
    expect(screen.getByRole('button', { name: 'Save report…' })).toBeEnabled()
  })
})
