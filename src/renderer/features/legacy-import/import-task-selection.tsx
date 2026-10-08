import { VirtualList } from '@renderer/components/desktop-kit/virtual-list/virtual-list'
import { ChevronDownIcon, ChevronRightIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Input } from '@renderer/components/ui/input'
import type { LegacyImportItem } from '@shared/schemas/legacy-import'
import {
  type Dispatch,
  type SetStateAction,
  useId,
  useMemo,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { ImportTaskInfo } from './import-task-info'

export const importTaskTypes = ['http', 'bt', 'magnet', 'unknown'] as const
type TaskType = LegacyImportItem['type']
type SelectionRow =
  | { kind: 'group'; type: TaskType; items: LegacyImportItem[] }
  | { kind: 'task'; item: LegacyImportItem }

export function initialExpandedGroups(items: LegacyImportItem[]) {
  const types = new Set(items.map((item) => item.type))
  return new Set(
    items
      .filter((item) => types.size === 1 || item.reason === 'metadata-required')
      .map((item) => item.type)
  )
}

/** A group always selects its full eligible contents, even while searching. */
export function toggleImportGroup(
  selected: ReadonlySet<string>,
  items: LegacyImportItem[],
  checked: boolean
) {
  const next = new Set(selected)
  for (const item of items) {
    if (!item.selectable) continue
    if (checked) next.add(item.itemId)
    else next.delete(item.itemId)
  }
  return next
}

export function ImportTaskSelection({
  items,
  selected,
  setSelected,
  expanded,
  setExpanded,
  query,
  setQuery,
  busy,
  running,
  chooseTorrent,
}: {
  items: LegacyImportItem[]
  selected: ReadonlySet<string>
  setSelected: Dispatch<SetStateAction<Set<string>>>
  expanded: ReadonlySet<TaskType>
  setExpanded: Dispatch<SetStateAction<Set<TaskType>>>
  query: string
  setQuery: (query: string) => void
  busy: boolean
  running: boolean
  chooseTorrent: (item: LegacyImportItem) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const search = query.trim().toLocaleLowerCase()
  const rows = useMemo(() => {
    const next: SelectionRow[] = []
    for (const type of importTaskTypes) {
      const group = items.filter((item) => item.type === type)
      const visible = group.filter((item) =>
        `${item.name} ${item.saveDir ?? ''}`
          .toLocaleLowerCase()
          .includes(search)
      )
      if (!group.length || (search && !visible.length)) continue
      next.push({ kind: 'group', type, items: group })
      if (search || expanded.has(type))
        next.push(
          ...visible.map((item): SelectionRow => ({ kind: 'task', item }))
        )
    }
    return next
  }, [items, expanded, search])
  const renderRow = (row: SelectionRow) => {
    if (row.kind === 'task') {
      const { item } = row
      return (
        <div
          key={item.itemId}
          data-import-task={item.itemId}
          data-import-row={item.itemId}
          data-selected={selected.has(item.itemId)}
          className="migration-task-row flex h-14 items-center gap-2 py-0.5 pe-3 ps-11"
        >
          <Checkbox
            aria-label={item.name}
            disabled={busy || !item.selectable}
            checked={item.selectable && selected.has(item.itemId)}
            onCheckedChange={(checked) =>
              setSelected((current) =>
                toggleImportGroup(current, [item], checked)
              )
            }
          />
          <ImportTaskInfo item={item} />
          {item.type === 'bt' && item.reason === 'metadata-required' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-w-32 whitespace-normal text-xs"
              disabled={busy || running}
              onClick={() => chooseTorrent(item)}
            >
              {t('legacyImport.chooseTorrent')}
            </Button>
          )}
        </div>
      )
    }
    const eligible = row.items.filter((item) => item.selectable)
    const count = eligible.filter((item) => selected.has(item.itemId)).length
    const isOpen = Boolean(search) || expanded.has(row.type)
    const title = t(`legacyImport.page.groups.${row.type}`)
    const groupId = `${id}-${row.type}`
    return (
      <div
        key={row.type}
        data-import-group={row.type}
        data-import-row={`group:${row.type}`}
        className="flex h-14 items-center gap-2 px-3"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-label={title}
          aria-expanded={isOpen}
          disabled={Boolean(search)}
          onClick={() =>
            setExpanded((current) => {
              const next = new Set(current)
              if (next.has(row.type)) next.delete(row.type)
              else next.add(row.type)
              return next
            })
          }
        >
          {isOpen ? (
            <ChevronDownIcon aria-hidden="true" className="size-4" />
          ) : (
            <ChevronRightIcon
              aria-hidden="true"
              className="size-4 rtl:rotate-180"
            />
          )}
        </Button>
        <Checkbox
          id={groupId}
          aria-labelledby={`${groupId}-label`}
          disabled={busy || eligible.length === 0}
          checked={eligible.length > 0 && count === eligible.length}
          indeterminate={count > 0 && count < eligible.length}
          onCheckedChange={(checked) =>
            setSelected((current) =>
              toggleImportGroup(current, row.items, checked)
            )
          }
        />
        <span id={`${groupId}-label`} className="sr-only">
          {t('legacyImport.page.selectGroup', { name: title })}
        </span>
        <label htmlFor={groupId} className="min-w-0 flex-1 cursor-pointer">
          <span className="block text-[13px] font-medium">{title}</span>
        </label>
        <span className="shrink-0 text-xs tabular-nums text-foreground/80">
          {t('legacyImport.page.groupCount', { count: row.items.length })}
        </span>
      </div>
    )
  }
  return (
    <>
      {items.length > 20 && (
        <div className="mx-auto mb-3 w-full max-w-160 shrink-0">
          <Input
            aria-label={t('legacyImport.search')}
            placeholder={t('legacyImport.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      <div
        className="mx-auto flex min-h-0 w-full max-w-160 flex-1 flex-col overflow-hidden rounded-lg border border-border"
        style={{ maxHeight: rows.length ? rows.length * 56 : 120 }}
      >
        {items.length > 100 ? (
          <VirtualList
            items={rows}
            getId={(row) =>
              row.kind === 'group' ? `group:${row.type}` : row.item.itemId
            }
            rowHeight={56}
            keepMountedIndex={rows.findIndex(
              (row) =>
                (row.kind === 'group'
                  ? `group:${row.type}`
                  : row.item.itemId) === focusedId
            )}
            containerProps={{
              onFocusCapture: (event) => {
                const row = (event.target as HTMLElement).closest<HTMLElement>(
                  '[data-import-row]'
                )
                if (row) setFocusedId(row.dataset.importRow ?? null)
              },
            }}
            className="min-h-0 flex-1"
            renderRow={({ item }) => renderRow(item)}
            renderEmpty={() => <EmptySelection searching={Boolean(search)} />}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            {rows.length ? (
              rows.map(renderRow)
            ) : (
              <EmptySelection searching={Boolean(search)} />
            )}
          </div>
        )}
      </div>
    </>
  )
}

function EmptySelection({ searching }: { searching: boolean }) {
  const { t } = useTranslation()
  return (
    <p className="px-6 py-10 text-center text-sm leading-relaxed text-muted-foreground">
      {t(searching ? 'legacyImport.page.searchEmpty' : 'legacyImport.empty')}
    </p>
  )
}
