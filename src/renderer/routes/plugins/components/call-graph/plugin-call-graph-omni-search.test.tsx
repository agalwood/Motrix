import '@testing-library/jest-dom/vitest'
import type { PluginCommandGraphEdge } from '@shared/types/plugin-command-graph'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallGraphNodeModel } from '../../lib/call-graph-model'
import {
  buildPluginCallGraphSuggestions,
  PluginCallGraphOmniSearch,
  type PluginCallGraphOmniSearchStrings,
} from './plugin-call-graph-omni-search'

const nodes: CallGraphNodeModel[] = [
  node('plugin.alpha', 'Alpha Tools'),
  node('plugin.beta', 'Beta Tools'),
]
const commandEdges: PluginCommandGraphEdge[] = [
  edge('plugin.alpha', 'plugin.beta', 'plugin.alpha.run'),
  edge('plugin.beta', 'plugin.alpha', 'plugin.beta.run'),
  edge('plugin.alpha', 'plugin.beta', 'plugin.alpha.run'),
]
const manyNodes = Array.from({ length: 8 }, (_, index) =>
  node(`plugin.extra-${index}`, `Plugin Extra ${index}`)
)
const strings: PluginCallGraphOmniSearchStrings = {
  searchLabel: 'Search relationships',
  searchPlaceholder: 'Find plugin or command',
  clearSearch: 'Clear search',
  pluginsGroup: 'Plugins',
  commandsGroup: 'Commands',
  noSuggestions: 'No suggestions',
}

const originalHasPointerCapture = HTMLElement.prototype.hasPointerCapture
const originalReleasePointerCapture =
  HTMLElement.prototype.releasePointerCapture
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.releasePointerCapture = () => {}
  HTMLElement.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  vi.unstubAllGlobals()
  HTMLElement.prototype.hasPointerCapture = originalHasPointerCapture
  HTMLElement.prototype.releasePointerCapture = originalReleasePointerCapture
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView
})

function node(id: string, name: string): CallGraphNodeModel {
  return {
    id,
    name,
    installed: true,
    status: 'active',
    incomingCalls: 1,
    outgoingCalls: 1,
  }
}

function edge(
  sourcePluginId: string,
  targetPluginId: string,
  commandId: string
): PluginCommandGraphEdge {
  return {
    sourcePluginId,
    targetPluginId,
    commandId,
    calls: 1,
    lastCalledAt: 1,
  }
}

function Harness({
  initialQuery = '',
  onQueryChange = () => {},
  captureQueryController,
}: {
  initialQuery?: string
  onQueryChange?: (query: string) => void
  captureQueryController?: (setQuery: (query: string) => void) => void
}) {
  const [query, setQuery] = useState(initialQuery)
  useEffect(() => {
    captureQueryController?.(setQuery)
  }, [captureQueryController])

  return (
    <PluginCallGraphOmniSearch
      query={query}
      onQueryChange={(nextQuery) => {
        setQuery(nextQuery)
        onQueryChange(nextQuery)
      }}
      nodes={nodes}
      commandEdges={commandEdges}
      strings={strings}
    />
  )
}

describe('buildPluginCallGraphSuggestions', () => {
  it('deduplicates, caps, and maps plugin/command selection values', () => {
    const result = buildPluginCallGraphSuggestions(nodes, commandEdges, 'alpha')
    expect(result.plugins.map((item) => item.key)).toEqual([
      'plugin:plugin.alpha',
    ])
    expect(result.plugins[0]).toMatchObject({
      kind: 'plugin',
      label: 'Alpha Tools',
      detail: 'plugin.alpha',
      queryValue: 'Alpha Tools',
    })

    const commands = buildPluginCallGraphSuggestions(nodes, commandEdges, 'run')
    expect(commands.commands.map((item) => item.queryValue)).toEqual([
      'plugin.alpha.run',
      'plugin.beta.run',
    ])
    expect(new Set(commands.commands.map((item) => item.key)).size).toBe(
      commands.commands.length
    )
    expect(buildPluginCallGraphSuggestions(nodes, commandEdges, '   ')).toEqual(
      {
        plugins: [],
        commands: [],
      }
    )
    expect(
      buildPluginCallGraphSuggestions(manyNodes, commandEdges, 'plugin').plugins
    ).toHaveLength(6)
  })

  it('ranks exact, prefix, and substring matches with stable tie-breaks', () => {
    const ranked = buildPluginCallGraphSuggestions(
      [
        node('id.substring', 'Tools Alpha'),
        node('id.prefix-b', 'Alpha Tool'),
        node('id.exact', 'Alpha'),
        node('id.prefix-a', 'Alpha Tool'),
      ],
      [],
      'alpha'
    )
    expect(ranked.plugins.map((item) => item.key)).toEqual([
      'plugin:id.exact',
      'plugin:id.prefix-a',
      'plugin:id.prefix-b',
      'plugin:id.substring',
    ])
  })
})

describe('PluginCallGraphOmniSearch', () => {
  it('updates controlled free text, groups results, preserves Escape, and clears', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onQueryChange = vi.fn()
    render(<Harness onQueryChange={onQueryChange} />)
    const search = screen.getByRole('combobox', { name: strings.searchLabel })
    expect(search).toHaveValue('')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await user.type(search, 'plugin')
    expect(onQueryChange).toHaveBeenLastCalledWith('plugin')
    expect(await screen.findByText(strings.pluginsGroup)).toBeVisible()
    expect(screen.getByText(strings.commandsGroup)).toBeVisible()
    expect(search).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('[Escape]')
    expect(search).toHaveValue('plugin')
    expect(search).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await user.keyboard('[Backspace]')
    expect(search).toHaveValue('plugi')
    expect(search).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByRole('listbox')).toBeVisible()

    await user.click(screen.getByRole('button', { name: strings.clearSearch }))
    expect(onQueryChange).toHaveBeenLastCalledWith('')
    expect(search).toHaveValue('')
    expect(search).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('closes when the controlled query is cleared externally', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    let setExternalQuery: ((query: string) => void) | undefined
    render(
      <Harness
        captureQueryController={(setQuery) => {
          setExternalQuery = setQuery
        }}
      />
    )
    const search = screen.getByRole('combobox', { name: strings.searchLabel })
    await user.type(search, 'plugin')
    expect(search).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByRole('listbox')).toBeVisible()

    act(() => {
      setExternalQuery?.('')
    })

    expect(search).toHaveValue('')
    expect(search).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('keeps an externally matched plugin ID option keyboard-selectable', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Harness />)
    const search = screen.getByRole('combobox', { name: strings.searchLabel })
    await user.type(search, 'plugin.alpha')
    expect(
      await screen.findByRole('option', {
        name: /Alpha Tools.*plugin\.alpha/,
      })
    ).toBeVisible()
    expect(screen.queryByText(strings.noSuggestions)).not.toBeInTheDocument()
    await user.keyboard('[ArrowDown][Enter]')
    expect(search).toHaveValue('Alpha Tools')
    expect(search).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('announces a no-match query', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Harness />)
    await user.type(
      screen.getByRole('combobox', { name: strings.searchLabel }),
      'no-match'
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      strings.noSuggestions
    )
  })
})
