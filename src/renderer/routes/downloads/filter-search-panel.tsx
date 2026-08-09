import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@renderer/components/ui/command'
import { formatBytes } from '@renderer/lib/format'
import { TASK_TYPE_META, TASK_TYPE_ORDER } from '@renderer/lib/task-type-meta'
import { cn } from '@renderer/lib/utils'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, type TaskType } from '@shared/types/task'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { taskMatchesQuery } from './filter'

export interface FilterSearchPanelProps {
  tasks: readonly DownloadTask[]
  types: readonly TaskType[]
  onTypesChange: (next: TaskType[]) => void
  typeCounts: Record<TaskType, number>
  onOpenTask: (task: DownloadTask) => void
}

// Finder result buckets, in display order. Keys map to panel.downloads.status.*
const GROUP_ORDER: readonly TaskStatus[] = [
  TaskStatus.Downloading,
  TaskStatus.Queued,
  TaskStatus.FetchingMetadata,
  TaskStatus.MetadataReady,
  TaskStatus.Finalizing,
  TaskStatus.Seeding,
  TaskStatus.Paused,
  TaskStatus.Completed,
  TaskStatus.Error,
]

function statusKey(status: TaskStatus): string {
  switch (status) {
    case TaskStatus.FetchingMetadata:
      return 'fetchingMetadata'
    case TaskStatus.MetadataReady:
      return 'metadataReady'
    default:
      return status // 'downloading' | 'paused' | 'completed' | 'error' | ...
  }
}

export function FilterSearchPanel({
  tasks,
  types,
  onTypesChange,
  typeCounts,
  onOpenTask,
}: FilterSearchPanelProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')

  // Finder scope: all non-removed tasks, constrained by the active type chips.
  const scoped = useMemo(
    () =>
      tasks.filter(
        (x) =>
          x.status !== TaskStatus.Removed &&
          (types.length === 0 || types.includes(x.type))
      ),
    [tasks, types]
  )
  const results = useMemo(
    () => scoped.filter((x) => taskMatchesQuery(x, query)),
    [scoped, query]
  )

  const toggleType = (ty: TaskType) => {
    onTypesChange(
      types.includes(ty) ? types.filter((x) => x !== ty) : [...types, ty]
    )
  }

  return (
    <Command shouldFilter={false} className="w-full">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t('panel.downloads.search.placeholder')}
        autoFocus
      />
      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
        <span className="mr-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('panel.downloads.search.scopeLabel')}
        </span>
        {TASK_TYPE_ORDER.map((ty) => {
          const meta = TASK_TYPE_META[ty]
          const Icon = meta.icon
          const on = types.includes(ty)
          const count = typeCounts[ty]
          return (
            <button
              key={ty}
              type="button"
              disabled={count === 0}
              onClick={() => toggleType(ty)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                on
                  ? 'border-primary/40 bg-primary/10 text-primary font-medium'
                  : 'border-border text-muted-foreground',
                count === 0 && 'opacity-40'
              )}
            >
              <Icon className="size-3" />
              {t(meta.labelKey)}
              <span className="opacity-60">{count}</span>
            </button>
          )
        })}
        {types.length > 0 && (
          <button
            type="button"
            onClick={() => onTypesChange([])}
            className="ml-auto text-xs text-primary"
          >
            {t('panel.downloads.search.clear')}
          </button>
        )}
      </div>
      <CommandList>
        {results.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <p className="text-sm">{t('panel.downloads.search.empty')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('panel.downloads.search.emptyHint')}
            </p>
          </div>
        ) : (
          GROUP_ORDER.map((status) => {
            const rows = results.filter((x) => x.status === status)
            if (rows.length === 0) return null
            return (
              <CommandGroup
                key={status}
                heading={t(`panel.downloads.status.${statusKey(status)}`)}
              >
                {rows.map((task) => {
                  const Icon = TASK_TYPE_META[task.type].icon
                  return (
                    <CommandItem
                      key={task.id}
                      value={task.id}
                      onSelect={() => onOpenTask(task)}
                    >
                      <Icon className="size-4" />
                      <span className="flex-1 truncate">{task.name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {task.status === TaskStatus.Downloading
                          ? `${Math.round(task.progress * 100)}%`
                          : formatBytes(task.sizeWhenDone)}
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )
          })
        )}
      </CommandList>
    </Command>
  )
}
