import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import type { PluginCommandGraphEdge } from '@shared/types/plugin-command-graph'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallGraphNodeModel } from '../../lib/call-graph-model'
import {
  PluginCallGraphToolbar,
  type PluginCallGraphToolbarProps,
  type PluginCallGraphToolbarStrings,
} from './plugin-call-graph-toolbar'

const strings: PluginCallGraphToolbarStrings = {
  toolbarLabel: 'Call graph controls',
  modeLabel: 'Relationship view',
  graphMode: 'Graph',
  tableMode: 'Table',
  omniSearch: {
    searchLabel: 'Search relationships',
    searchPlaceholder: 'Find plugin or command',
    clearSearch: 'Clear search',
    pluginsGroup: 'Plugins',
    commandsGroup: 'Commands',
    noSuggestions: 'No plugin or command suggestions',
  },
  refresh: 'Refresh',
  refreshing: 'Refreshing',
  refreshTooltip: 'Load the latest successful calls',
  renderGraphTooltip: 'Render this large result as a graph',
}

const nodes: ReadonlyArray<CallGraphNodeModel> = [
  {
    id: 'plugin.alpha',
    name: 'Alpha Tools',
    installed: true,
    status: 'active',
    incomingCalls: 2,
    outgoingCalls: 4,
  },
  {
    id: 'plugin.beta',
    name: 'Beta Tools',
    installed: true,
    status: 'disabled',
    incomingCalls: 4,
    outgoingCalls: 0,
  },
  {
    id: 'plugin.removed',
    name: 'plugin.removed',
    installed: false,
    status: 'missing',
    incomingCalls: 1,
    outgoingCalls: 0,
  },
]
const commandEdges: ReadonlyArray<PluginCommandGraphEdge> = [
  {
    sourcePluginId: 'plugin.alpha',
    targetPluginId: 'plugin.beta',
    commandId: 'plugin.beta.run',
    calls: 1,
    lastCalledAt: 1,
  },
]

const modeIds = {
  graph: {
    triggerId: 'plugin-call-graph-trigger',
    panelId: 'plugin-call-graph-panel',
  },
  table: {
    triggerId: 'plugin-call-table-trigger',
    panelId: 'plugin-call-table-panel',
  },
} as const

function props(
  overrides: Partial<PluginCallGraphToolbarProps> = {}
): PluginCallGraphToolbarProps {
  return {
    mode: 'graph',
    onModeChange: vi.fn(),
    query: '',
    onQueryChange: vi.fn(),
    nodes,
    commandEdges,
    density: 'full',
    isRefreshing: false,
    onRefresh: vi.fn(),
    modeIds,
    strings,
    ...overrides,
  }
}

interface RadixPrototypeSnapshot {
  hasPointerCapture?: typeof HTMLElement.prototype.hasPointerCapture
  releasePointerCapture?: typeof HTMLElement.prototype.releasePointerCapture
  scrollIntoView?: typeof HTMLElement.prototype.scrollIntoView
}

let radixPrototypeSnapshot: RadixPrototypeSnapshot

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  radixPrototypeSnapshot = {
    hasPointerCapture: HTMLElement.prototype.hasPointerCapture,
    releasePointerCapture: HTMLElement.prototype.releasePointerCapture,
    scrollIntoView: HTMLElement.prototype.scrollIntoView,
  }
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.releasePointerCapture = () => {}
  HTMLElement.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (radixPrototypeSnapshot.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture =
      radixPrototypeSnapshot.hasPointerCapture
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'hasPointerCapture')
  }
  if (radixPrototypeSnapshot.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture =
      radixPrototypeSnapshot.releasePointerCapture
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'releasePointerCapture')
  }
  if (radixPrototypeSnapshot.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = radixPrototypeSnapshot.scrollIntoView
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
})

function renderToolbar(toolbarProps: PluginCallGraphToolbarProps) {
  return render(
    <TooltipProvider>
      <PluginCallGraphToolbar {...toolbarProps} />
    </TooltipProvider>
  )
}

function renderToolbarWithPanels(toolbarProps: PluginCallGraphToolbarProps) {
  return render(
    <TooltipProvider>
      <PluginCallGraphToolbar {...toolbarProps} />
      <section
        role="tabpanel"
        id={modeIds.graph.panelId}
        aria-labelledby={modeIds.graph.triggerId}
        hidden={toolbarProps.mode !== 'graph'}
      >
        Graph panel fixture
      </section>
      <section
        role="tabpanel"
        id={modeIds.table.panelId}
        aria-labelledby={modeIds.table.triggerId}
        hidden={toolbarProps.mode !== 'table'}
      >
        Table panel fixture
      </section>
    </TooltipProvider>
  )
}

describe('PluginCallGraphToolbar', () => {
  it('exposes a controlled, keyboard-operable Graph and Table switch', async () => {
    const user = userEvent.setup()
    const onModeChange = vi.fn()
    const { rerender } = renderToolbar(props({ mode: 'graph', onModeChange }))

    const modeTabs = screen.getByRole('tablist', {
      name: strings.modeLabel,
    })
    const graphTab = within(modeTabs).getByRole('tab', {
      name: strings.graphMode,
    })
    const tableTab = within(modeTabs).getByRole('tab', {
      name: strings.tableMode,
    })
    expect(graphTab.textContent).toBe('')
    expect(tableTab.textContent).toBe('')
    expect(graphTab.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(tableTab.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(graphTab).toHaveAttribute('aria-selected', 'true')

    await user.click(graphTab)
    await user.keyboard('[ArrowRight]')
    expect(tableTab).toHaveFocus()
    expect(onModeChange).not.toHaveBeenCalled()
    await user.keyboard('[Enter]')
    expect(onModeChange).toHaveBeenLastCalledWith('table')
    expect(graphTab).toHaveAttribute('aria-selected', 'true')

    rerender(
      <TooltipProvider>
        <PluginCallGraphToolbar {...props({ mode: 'table', onModeChange })} />
      </TooltipProvider>
    )
    await user.click(tableTab)
    await user.keyboard('[ArrowLeft]')
    expect(graphTab).toHaveFocus()
    await user.keyboard('[Enter]')
    expect(onModeChange).toHaveBeenLastCalledWith('graph')

    rerender(
      <TooltipProvider>
        <PluginCallGraphToolbar {...props({ mode: 'graph', onModeChange })} />
      </TooltipProvider>
    )
    await user.click(tableTab)
    expect(onModeChange).toHaveBeenLastCalledWith('table')
  })

  it('associates stable triggers with external panels without losing keyboard operation', async () => {
    const user = userEvent.setup()
    const onModeChange = vi.fn()
    renderToolbarWithPanels(props({ mode: 'graph', onModeChange }))

    const graphTab = screen.getByRole('tab', { name: strings.graphMode })
    const tableTab = screen.getByRole('tab', { name: strings.tableMode })
    const graphPanel = document.getElementById(modeIds.graph.panelId)
    const tablePanel = document.getElementById(modeIds.table.panelId)

    expect(graphTab).toHaveAttribute('id', modeIds.graph.triggerId)
    expect(graphTab).toHaveAttribute('aria-controls', modeIds.graph.panelId)
    expect(graphPanel).toHaveAttribute(
      'aria-labelledby',
      modeIds.graph.triggerId
    )
    expect(tableTab).toHaveAttribute('id', modeIds.table.triggerId)
    expect(tableTab).toHaveAttribute('aria-controls', modeIds.table.panelId)
    expect(tablePanel).toHaveAttribute(
      'aria-labelledby',
      modeIds.table.triggerId
    )
    expect(
      document.getElementById(graphTab.getAttribute('aria-controls')!)
    ).toBe(graphPanel)
    expect(
      document.getElementById(tableTab.getAttribute('aria-controls')!)
    ).toBe(tablePanel)

    graphTab.focus()
    await user.keyboard('[ArrowRight]')
    expect(tableTab).toHaveFocus()
    expect(onModeChange).not.toHaveBeenCalled()
    await user.keyboard('[Enter]')
    expect(onModeChange).toHaveBeenCalledWith('table')
  })

  it('uses one controlled OmniSearch and removes obsolete filter actions', () => {
    const onQueryChange = vi.fn()
    renderToolbar(
      props({
        query: 'alpha',
        onQueryChange,
      })
    )

    const search = screen.getByRole('combobox', {
      name: strings.omniSearch.searchLabel,
    })
    expect(search).toHaveValue('alpha')
    fireEvent.change(search, { target: { value: 'command.run' } })
    expect(onQueryChange).toHaveBeenLastCalledWith('command.run')
    expect(
      screen.queryByRole('combobox', { name: /Filter by plugin/i })
    ).toBeNull()
    expect(screen.queryByRole('button', { name: /Clear filters/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Render graph' })).toBeNull()
    expect(screen.getByTestId('plugin-call-graph-toolbar-primary')).toHaveClass(
      'grid-cols-1',
      '@[40rem]/call-graph:grid-cols-[minmax(0,1fr)_auto]'
    )
    expect(screen.getByTestId('plugin-call-graph-toolbar-actions')).toHaveClass(
      'justify-self-end',
      'whitespace-nowrap'
    )
  })

  it('prevents repeated refresh while busy', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    const { rerender } = renderToolbar(props({ onRefresh }))

    const refresh = screen.getByRole('button', { name: strings.refresh })
    expect(refresh.textContent).toBe('')
    expect(refresh.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    await user.hover(refresh)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      strings.refreshTooltip
    )
    await user.click(refresh)
    expect(onRefresh).toHaveBeenCalledTimes(1)

    rerender(
      <TooltipProvider>
        <PluginCallGraphToolbar {...props({ isRefreshing: true, onRefresh })} />
      </TooltipProvider>
    )
    const busyRefresh = screen.getByRole('button', {
      name: strings.refreshing,
    })
    expect(busyRefresh).toBeDisabled()
    expect(busyRefresh).toHaveAttribute('aria-busy', 'true')
    expect(busyRefresh.querySelector('svg')).toHaveClass(
      'animate-spin',
      'motion-reduce:animate-none'
    )
    await user.click(busyRefresh)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('uses the Workflow tab to render a table-first result', async () => {
    const user = userEvent.setup()
    const onModeChange = vi.fn()
    renderToolbar(
      props({ density: 'table-first', mode: 'table', onModeChange })
    )

    expect(screen.queryByRole('button', { name: 'Render graph' })).toBeNull()
    const workflow = screen.getByRole('tab', {
      name: strings.graphMode,
    })
    await user.hover(workflow)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      strings.renderGraphTooltip
    )
    await user.click(workflow)
    expect(onModeChange).toHaveBeenCalledWith('graph')
  })
})
