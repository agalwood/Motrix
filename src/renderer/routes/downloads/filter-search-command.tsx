import { Button } from '@renderer/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@renderer/components/ui/popover'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FilterSearchPanel,
  type FilterSearchPanelProps,
} from './filter-search-panel'

export type FilterSearchCommandProps = FilterSearchPanelProps

export function FilterSearchCommand({
  tasks,
  types,
  onTypesChange,
  typeCounts,
  onOpenTask,
}: FilterSearchCommandProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const active = types.length > 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('panel.downloads.search.placeholder')}
            // In the collapsed (40px) header the button keeps its 32px visual
            // size — icon position and hover circle stay identical to the
            // expanded state — but -my-2 cancels the extra layout height so
            // the row stays 16px tall like the title trigger.
            className="app-no-drag relative size-8 rounded-full compact-header:-my-0.5"
          />
        }
      >
        <Search className="size-4 text-muted-foreground" />
        {active && (
          <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-background" />
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="app-no-drag z-[60] w-[340px] p-0"
        initialFocus={false}
      >
        <FilterSearchPanel
          tasks={tasks}
          types={types}
          onTypesChange={onTypesChange}
          typeCounts={typeCounts}
          onOpenTask={(task) => {
            onOpenTask(task)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
