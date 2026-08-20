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
            // Match the 28px window-chrome targets so compact panel actions
            // stay on the Toggle Sidebar and Add Task centerline.
            className="panel-action-align-visual-end app-no-drag relative size-7 rounded-full bg-transparent hover:bg-transparent dark:hover:bg-transparent [&>svg]:opacity-50 hover:[&>svg]:opacity-75 focus-visible:[&>svg]:opacity-75"
          />
        }
      >
        <Search className="size-4" />
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
