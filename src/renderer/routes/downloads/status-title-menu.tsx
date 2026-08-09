import { PANEL_TITLE_CLASS } from '@renderer/components/desktop-kit/panel/panel-shell'
import { Badge } from '@renderer/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { cn } from '@renderer/lib/utils'
import { Check, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DOWNLOADS_TABS, type DownloadsTab } from './filter'

export interface StatusTitleMenuProps {
  tab: DownloadsTab
  onTabChange: (tab: DownloadsTab) => void
  counts: Record<DownloadsTab, number>
}

export function StatusTitleMenu({
  tab,
  onTabChange,
  counts,
}: StatusTitleMenuProps) {
  const { t } = useTranslation()
  const statusLabel = t(`panel.downloads.tab.${tab}`)
  const title = `${statusLabel} ${t('panel.downloads.title')}`

  return (
    <div className="flex min-w-0 items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              // relative z-[60] lifts the trigger above the z-50 WindowChrome
              // drag strip; without it, in the collapsed (short) header the
              // strip covers the trigger and `no-drag` is overridden by the
              // strip's `drag` region, so clicks become window-drags.
              // h-8 / h-4 pins the trigger to the search button's height per
              // sidebar state (32px expanded, 16px collapsed) so the two
              // controls read as a centered, size-aligned pair (items-center
              // vertically centers the title text).
              className="app-no-drag relative z-[40] flex h-8 items-center gap-1 outline-hidden compact-header:h-7"
            />
          }
        >
          <h1 className={PANEL_TITLE_CLASS}>{title}</h1>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground compact-header:size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="app-no-drag">
          {DOWNLOADS_TABS.map((key) => (
            <DropdownMenuItem
              key={key}
              onClick={() => onTabChange(key)}
              className="gap-2"
            >
              <Check
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
        <Badge variant="outline">{`${counts[tab]}/${counts.all}`}</Badge>
      </div>
    </div>
  )
}
