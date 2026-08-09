import '@testing-library/jest-dom/vitest'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PluginCallGraphLegend } from './plugin-call-graph-legend'

describe('PluginCallGraphLegend', () => {
  it('exposes both ends of the visual call-volume scale', () => {
    render(
      <PluginCallGraphLegend
        strings={{
          label: 'Call volume legend',
          fewerCalls: 'Fewer calls',
          moreCalls: 'More calls',
        }}
      />
    )
    const legend = screen.getByRole('group', { name: 'Call volume legend' })
    expect(within(legend).getByText('Fewer calls')).toBeVisible()
    expect(within(legend).getByText('More calls')).toBeVisible()
    expect(within(legend).getByTestId('call-volume-thin')).toHaveClass(
      'h-[2px]'
    )
    expect(within(legend).getByTestId('call-volume-thick')).toHaveClass(
      'h-[6px]'
    )
    expect(legend).toHaveClass('pointer-events-none')
  })
})
