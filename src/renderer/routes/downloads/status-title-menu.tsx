import { PANEL_TITLE_CLASS } from '@renderer/components/desktop-kit/panel/panel-shell'
import { CheckIcon, ChevronDownIcon } from '@renderer/components/icons'
import { Badge } from '@renderer/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { cn } from '@renderer/lib/utils'
import { useTranslation } from 'react-i18next'
import { DOWNLOADS_TABS, type DownloadsTab } from './filter'

export interface StatusTitleMenuProps {
  tab: DownloadsTab
  onTabChange: (tab: DownloadsTab) => void
  counts: Record<DownloadsTab, number>
  visibleCount?: number
}

export function StatusTitleMenu({
  tab,
  onTabChange,
  counts,
  visibleCount = counts[tab],
}: StatusTitleMenuProps) {
  const { t } = useTranslation()
  const title = t(`panel.downloads.heading.${tab}`)

  return (
    <div className="flex min-w-0 items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              // Align the title with the compact toolbar above the window drag strip.
              className="app-no-drag relative z-[40] flex h-9 min-w-0 items-center gap-1 outline-hidden compact-header:h-7"
            />
          }
        >
          <h1 className={cn(PANEL_TITLE_CLASS, 'truncate')}>{title}</h1>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground compact-header:size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="app-no-drag"
          data-menu-density="compact"
        >
          {DOWNLOADS_TABS.map((key) => (
            <DropdownMenuItem
              key={key}
              onClick={() => onTabChange(key)}
              className="gap-2"
            >
              <CheckIcon
                className={cn(
                  'size-4',
                  key === tab ? 'opacity-100' : 'opacity-0'
                )}
              />
              <span className="flex-1">{t(`panel.downloads.tab.${key}`)}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {counts[key]}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Inline count on the title line — hidden when collapsed/narrow so the
          header stays a single tight row. */}
      <div className="shrink-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums compact-header:hidden">
        <Badge variant="outline">{`${visibleCount}/${counts.all}`}</Badge>
      </div>
    </div>
  )
}
