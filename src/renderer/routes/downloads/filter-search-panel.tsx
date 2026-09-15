import { TASK_TYPE_META, TASK_TYPE_ORDER } from '@renderer/lib/task-type-meta'
import { cn } from '@renderer/lib/utils'
import type { TaskType } from '@shared/types/task'
import { useTranslation } from 'react-i18next'

export interface FilterSearchPanelProps {
  types: readonly TaskType[]
  onTypesChange: (next: TaskType[]) => void
  typeCounts: Record<TaskType, number>
}

export function FilterSearchPanel({
  types,
  onTypesChange,
  typeCounts,
}: FilterSearchPanelProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">
          {t('panel.downloads.search.scopeLabel')}
        </span>
        <button
          type="button"
          disabled={types.length === 0}
          onClick={() => onTypesChange([])}
          className="rounded px-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring disabled:opacity-40"
        >
          {t('panel.downloads.search.resetFilters')}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {TASK_TYPE_ORDER.map((type) => {
          const meta = TASK_TYPE_META[type]
          const Icon = meta.icon
          const selected = types.includes(type)
          const count = typeCounts[type]
          return (
            <button
              key={type}
              type="button"
              aria-pressed={selected}
              disabled={count === 0 && !selected}
              onClick={() =>
                onTypesChange(
                  selected
                    ? types.filter((value) => value !== type)
                    : [...types, type]
                )
              }
              className={cn(
                'inline-flex min-h-6 items-center gap-1 rounded-full border px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40',
                selected
                  ? 'border-[#7388a3]/50 bg-[#e4ebf3] text-[#31577d] dark:border-[#97aac4]/50 dark:bg-[#303d50] dark:text-[#b4c9e5]'
                  : 'border-border text-muted-foreground hover:bg-accent'
              )}
            >
              <Icon className="size-3" />
              {t(meta.labelKey)}
              <span className="opacity-60 tabular-nums">{count}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
