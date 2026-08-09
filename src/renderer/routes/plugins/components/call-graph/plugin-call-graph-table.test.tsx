import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCallGraphModel } from '../../lib/call-graph-model'
import {
  PluginCallGraphTable,
  type PluginCallGraphTableStrings,
} from './plugin-call-graph-table'

const formatLastCall = vi.fn(
  (timestamp: number) => `localized timestamp ${timestamp}`
)

const strings: PluginCallGraphTableStrings = {
  tableRegionLabel: 'Scrollable command relationships',
  tableLabel: 'Plugin command relationships',
  caller: 'Caller',
  command: 'Command',
  callee: 'Callee',
  calls: 'Calls',
  lastCall: 'Last call',
  filteredEmpty: 'No successful calls match these filters.',
  formatLastCall,
}

const longCommandId =
  'plugin.gamma.command.with-a-complete-and-intentionally-long-identifier'

const model = buildCallGraphModel(
  {
    edges: [
      {
        sourcePluginId: 'plugin.beta',
        targetPluginId: 'plugin.gamma',
        commandId: longCommandId,
        calls: 2,
        lastCalledAt: 200,
      },
      {
        sourcePluginId: 'plugin.alpha',
        targetPluginId: 'plugin.beta',
        commandId: 'plugin.beta.run',
        calls: 9,
        lastCalledAt: 300,
      },
      {
        sourcePluginId: 'plugin.alpha',
        targetPluginId: 'plugin.gamma',
        commandId: 'plugin.gamma.inspect',
        calls: 2,
        lastCalledAt: 100,
      },
    ],
  },
  [
    { id: 'plugin.alpha', name: 'Alpha Tools', status: 'active' },
    { id: 'plugin.beta', name: 'Beta Tools', status: 'disabled' },
    { id: 'plugin.gamma', name: 'Gamma Tools', status: 'inactive' },
  ]
)

beforeEach(() => {
  formatLastCall.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('PluginCallGraphTable', () => {
  it('renders a native table with semantic scoped column headers', () => {
    render(<PluginCallGraphTable rows={model.tableRows} strings={strings} />)

    const table = screen.getByRole('table', { name: strings.tableLabel })
    expect(table.tagName).toBe('TABLE')
    const headers = within(table).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual([
      strings.caller,
      strings.command,
      strings.callee,
      strings.calls,
      strings.lastCall,
    ])
    for (const header of headers) expect(header).toHaveAttribute('scope', 'col')
  })

  it('keeps the stable Task 6 row order and complete command details', () => {
    render(<PluginCallGraphTable rows={model.tableRows} strings={strings} />)

    const table = screen.getByRole('table', { name: strings.tableLabel })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('plugin.alpha')
    expect(rows[0]).toHaveTextContent('plugin.beta.run')
    expect(rows[0]).toHaveTextContent('9')
    expect(rows[1]).toHaveTextContent('plugin.alpha')
    expect(rows[1]).toHaveTextContent('plugin.gamma.inspect')
    expect(rows[2]).toHaveTextContent('plugin.beta')
    expect(rows[2]).toHaveTextContent(longCommandId)
    expect(screen.getByText(longCommandId)).not.toHaveClass('truncate')
  })

  it('isolates every technical identifier as LTR text', () => {
    const { container } = render(
      <PluginCallGraphTable rows={model.tableRows} strings={strings} />
    )

    const identifiers = container.querySelectorAll('tbody bdi[dir="ltr"]')
    expect(identifiers).toHaveLength(model.tableRows.length * 3)
    expect(
      [...identifiers].map((identifier) => identifier.textContent)
    ).toContain(longCommandId)
  })

  it('right-aligns tabular counts and formats every timestamp through localized copy', () => {
    render(<PluginCallGraphTable rows={model.tableRows} strings={strings} />)

    const table = screen.getByRole('table', { name: strings.tableLabel })
    const firstDataRow = within(table).getAllByRole('row')[1]
    const cells = within(firstDataRow).getAllByRole('cell')
    expect(cells[3]).toHaveClass('text-right', 'tabular-nums')
    expect(cells[4]).toHaveClass('text-right', 'tabular-nums')
    expect(cells[4]).toHaveTextContent('localized timestamp 300')
    expect(formatLastCall.mock.calls.map(([timestamp]) => timestamp)).toEqual([
      300, 100, 200,
    ])
  })

  it('shows localized filtered-empty copy without adding an inspector', () => {
    render(<PluginCallGraphTable rows={[]} strings={strings} />)

    expect(screen.getByText(strings.filteredEmpty)).toBeInTheDocument()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('owns the single labeled mode scroller with a sticky header', () => {
    const { container } = render(
      <PluginCallGraphTable rows={model.tableRows} strings={strings} />
    )

    const region = screen.getByRole('region', {
      name: strings.tableRegionLabel,
    })
    expect(region).toHaveClass('min-h-0', 'flex-1', 'overflow-auto')
    expect(container.querySelectorAll('.overflow-auto')).toHaveLength(1)
    expect(region.querySelector('thead')).toHaveClass(
      'sticky',
      'top-0',
      'z-10',
      'bg-background'
    )
    expect(region.className).not.toContain('360')
  })
})
