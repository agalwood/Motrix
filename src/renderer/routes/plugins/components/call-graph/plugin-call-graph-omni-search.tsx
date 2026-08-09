import {
  Autocomplete,
  AutocompleteCollection,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteGroup,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteLabel,
  AutocompleteList,
  AutocompleteSeparator,
} from '@renderer/components/ui/autocomplete'
import { InputGroupAddon } from '@renderer/components/ui/input-group'
import type { PluginCommandGraphEdge } from '@shared/types/plugin-command-graph'
import { SearchIcon } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import type { CallGraphNodeModel } from '../../lib/call-graph-model'

const MAX_SUGGESTIONS_PER_GROUP = 6

export interface PluginCallGraphSearchSuggestion {
  key: string
  kind: 'plugin' | 'command'
  label: string
  detail?: string
  queryValue: string
  searchValues: ReadonlyArray<string>
}

export interface PluginCallGraphSuggestionGroups {
  plugins: PluginCallGraphSearchSuggestion[]
  commands: PluginCallGraphSearchSuggestion[]
}

interface PluginCallGraphSuggestionGroup {
  id: 'plugins' | 'commands'
  label: string
  items: PluginCallGraphSearchSuggestion[]
}

export interface PluginCallGraphOmniSearchStrings {
  searchLabel: string
  searchPlaceholder: string
  clearSearch: string
  pluginsGroup: string
  commandsGroup: string
  noSuggestions: string
}

export interface PluginCallGraphOmniSearchProps {
  query: string
  onQueryChange: (query: string) => void
  nodes: ReadonlyArray<CallGraphNodeModel>
  commandEdges: ReadonlyArray<PluginCommandGraphEdge>
  strings: PluginCallGraphOmniSearchStrings
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function matchRank(
  suggestion: PluginCallGraphSearchSuggestion,
  query: string
): number | null {
  const values = suggestion.searchValues.map(normalize)
  if (values.some((value) => value === query)) return 0
  if (values.some((value) => value.startsWith(query))) return 1
  if (values.some((value) => value.includes(query))) return 2
  return null
}

function compareText(left: string, right: string): number {
  const normalizedLeft = left.toLowerCase()
  const normalizedRight = right.toLowerCase()
  if (normalizedLeft < normalizedRight) return -1
  if (normalizedLeft > normalizedRight) return 1
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function filterAndRank(
  suggestions: ReadonlyArray<PluginCallGraphSearchSuggestion>,
  query: string
): PluginCallGraphSearchSuggestion[] {
  return suggestions
    .map((suggestion) => ({ suggestion, rank: matchRank(suggestion, query) }))
    .filter(
      (
        candidate
      ): candidate is {
        suggestion: PluginCallGraphSearchSuggestion
        rank: number
      } => candidate.rank !== null
    )
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        compareText(left.suggestion.label, right.suggestion.label) ||
        compareText(left.suggestion.key, right.suggestion.key)
    )
    .slice(0, MAX_SUGGESTIONS_PER_GROUP)
    .map(({ suggestion }) => suggestion)
}

export function buildPluginCallGraphSuggestions(
  nodes: ReadonlyArray<CallGraphNodeModel>,
  commandEdges: ReadonlyArray<PluginCommandGraphEdge>,
  rawQuery: string
): PluginCallGraphSuggestionGroups {
  const query = normalize(rawQuery)
  if (!query) return { plugins: [], commands: [] }

  const plugins = nodes.map(
    (node): PluginCallGraphSearchSuggestion => ({
      key: `plugin:${node.id}`,
      kind: 'plugin',
      label: node.name,
      detail: node.name === node.id ? undefined : node.id,
      queryValue: node.name,
      searchValues: [node.name, node.id],
    })
  )
  const commandIds = [...new Set(commandEdges.map((edge) => edge.commandId))]
  const commands = commandIds.map(
    (commandId): PluginCallGraphSearchSuggestion => ({
      key: `command:${commandId}`,
      kind: 'command',
      label: commandId,
      queryValue: commandId,
      searchValues: [commandId],
    })
  )

  return {
    plugins: filterAndRank(plugins, query),
    commands: filterAndRank(commands, query),
  }
}

export function PluginCallGraphOmniSearch({
  query,
  onQueryChange,
  nodes,
  commandEdges,
  strings,
}: PluginCallGraphOmniSearchProps) {
  const suggestions = useMemo(
    () => buildPluginCallGraphSuggestions(nodes, commandEdges, query),
    [commandEdges, nodes, query]
  )
  const groups: PluginCallGraphSuggestionGroup[] = [
    ...(suggestions.plugins.length > 0
      ? [
          {
            id: 'plugins' as const,
            label: strings.pluginsGroup,
            items: suggestions.plugins,
          },
        ]
      : []),
    ...(suggestions.commands.length > 0
      ? [
          {
            id: 'commands' as const,
            label: strings.commandsGroup,
            items: suggestions.commands,
          },
        ]
      : []),
  ]
  const hasQuery = query.trim().length > 0
  const [requestedOpen, setRequestedOpen] = useState(false)

  return (
    <Autocomplete
      items={groups}
      filter={null}
      value={query}
      onValueChange={onQueryChange}
      open={hasQuery && requestedOpen}
      onOpenChange={setRequestedOpen}
      itemToStringValue={(item: PluginCallGraphSearchSuggestion) =>
        item.queryValue
      }
    >
      <AutocompleteInput
        type="text"
        aria-label={strings.searchLabel}
        placeholder={strings.searchPlaceholder}
        showClear={hasQuery}
        clearLabel={strings.clearSearch}
        className="h-9 w-full min-w-0"
      >
        <InputGroupAddon align="inline-start">
          <SearchIcon aria-hidden="true" />
        </InputGroupAddon>
      </AutocompleteInput>

      {hasQuery && (
        <AutocompleteContent>
          <AutocompleteEmpty>{strings.noSuggestions}</AutocompleteEmpty>
          <AutocompleteList>
            {(group: PluginCallGraphSuggestionGroup, groupIndex: number) => (
              <Fragment key={group.id}>
                {groupIndex > 0 && <AutocompleteSeparator />}
                <AutocompleteGroup items={group.items}>
                  <AutocompleteLabel>{group.label}</AutocompleteLabel>
                  <AutocompleteCollection>
                    {(suggestion: PluginCallGraphSearchSuggestion) => (
                      <AutocompleteItem key={suggestion.key} value={suggestion}>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">
                            {suggestion.label}
                          </span>
                          {suggestion.detail && (
                            <code className="block truncate text-xs text-muted-foreground">
                              <bdi dir="ltr">{suggestion.detail}</bdi>
                            </code>
                          )}
                        </span>
                      </AutocompleteItem>
                    )}
                  </AutocompleteCollection>
                </AutocompleteGroup>
              </Fragment>
            )}
          </AutocompleteList>
        </AutocompleteContent>
      )}
    </Autocomplete>
  )
}
