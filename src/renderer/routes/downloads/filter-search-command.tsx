import { ToolbarSearch } from '@renderer/components/desktop-kit/toolbar/toolbar-search'
import { FilterIcon } from '@renderer/components/icons'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@renderer/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { TASK_TYPE_META, TASK_TYPE_ORDER } from '@renderer/lib/task-type-meta'
import { cn } from '@renderer/lib/utils'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DownloadsToolbarButton } from './downloads-toolbar-button'
import {
  FilterSearchPanel,
  type FilterSearchPanelProps,
} from './filter-search-panel'

export interface FilterSearchCommandProps extends FilterSearchPanelProps {
  query: string
  onQueryChange: (query: string) => void
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  width: number
}

export function FilterSearchCommand({
  query,
  onQueryChange,
  types,
  onTypesChange,
  typeCounts,
  expanded,
  onExpandedChange,
  width,
}: FilterSearchCommandProps) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [popupPresent, setPopupPresent] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLButtonElement>(null)
  const active = Boolean(query.trim()) || types.length > 0
  const descriptions = [
    query.trim()
      ? t('panel.downloads.search.activeQuery', { query: query.trim() })
      : null,
    types.length > 0
      ? t('panel.downloads.search.activeTypeFilters', {
          types: new Intl.ListFormat(i18n.language, {
            style: 'long',
            type: 'conjunction',
          }).format(
            TASK_TYPE_ORDER.filter((type) => types.includes(type)).map((type) =>
              t(TASK_TYPE_META[type].labelKey)
            )
          ),
        })
      : null,
  ].filter(Boolean)
  const filterLabel = [
    t('panel.downloads.search.filters'),
    ...descriptions,
  ].join(' · ')

  return (
    <ToolbarSearch
      data-slot="downloads-search"
      data-filter-active={active}
      value={query}
      onValueChange={onQueryChange}
      label={t('panel.downloads.search.placeholder')}
      clearLabel={t('common.clearSearch')}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      keepExpanded={types.length > 0 || open}
      onEmptyEscape={() => filterRef.current?.focus()}
      width={width}
      leading={({ anchorRef, collapseIfIdle }) => (
        <Popover
          open={open}
          onOpenChange={(next, details) => {
            setOpen(next)
            if (next) {
              setPopupPresent(true)
              onExpandedChange(true)
            }
            if (
              !next &&
              (details.reason === 'outside-press' ||
                details.reason === 'focus-out')
            )
              collapseIfIdle()
          }}
          onOpenChangeComplete={(next) => {
            if (!next) setPopupPresent(false)
          }}
        >
          <Tooltip disabled={open}>
            <TooltipTrigger
              delay={400}
              render={
                <PopoverTrigger
                  render={
                    <DownloadsToolbarButton
                      ref={filterRef}
                      aria-label={filterLabel}
                      className={
                        active
                          ? 'text-[#006bd6] dark:text-[#69aeff] [&>svg]:opacity-100 hover:text-[#006bd6] dark:hover:text-[#69aeff]'
                          : undefined
                      }
                    />
                  }
                />
              }
            >
              <FilterIcon className="size-4" />
            </TooltipTrigger>
            <TooltipContent
              anchor={anchorRef}
              side="bottom"
              align="start"
              sideOffset={8}
              className={cn(
                'block max-w-(--anchor-width) [overflow-wrap:anywhere]',
                popupPresent && 'invisible'
              )}
            >
              <p>{t('panel.downloads.search.filters')}</p>
              {descriptions.map((description) => (
                <p key={description} className="mt-1 opacity-80">
                  {description}
                </p>
              ))}
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            ref={popupRef}
            anchor={anchorRef}
            aria-label={t('panel.downloads.search.filters')}
            align="start"
            sideOffset={8}
            className="app-no-drag w-(--anchor-width) max-w-[calc(100vw-24px)] p-0"
          >
            <FilterSearchPanel
              types={types}
              onTypesChange={onTypesChange}
              typeCounts={typeCounts}
            />
          </PopoverContent>
        </Popover>
      )}
    />
  )
}
