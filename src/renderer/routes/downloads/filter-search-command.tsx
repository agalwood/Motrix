import { useCompactHeader } from '@renderer/components/desktop-kit/hooks/use-compact-header'
import { ToolbarGlass } from '@renderer/components/desktop-kit/toolbar-glass/toolbar-glass'
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
import { CircleX, ListFilter, Search } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
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
  glassEnabled?: boolean
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
  glassEnabled = false,
}: FilterSearchCommandProps) {
  const compact = useCompactHeader()
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [popupPresent, setPopupPresent] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLButtonElement>(null)
  const filterRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)
  const focusOnExpand = useRef(false)
  const blurFrame = useRef<number | null>(null)
  const active = Boolean(query.trim()) || types.length > 0
  const latest = useRef({ active, open })
  latest.current = { active, open }
  const inputId = useId()
  const label = t('panel.downloads.search.placeholder')
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
  const collapseIfIdle = () => {
    if (blurFrame.current !== null) cancelAnimationFrame(blurFrame.current)
    blurFrame.current = requestAnimationFrame(() => {
      const focused = document.activeElement
      if (
        !latest.current.active &&
        !latest.current.open &&
        !rootRef.current?.contains(focused) &&
        !popupRef.current?.contains(focused)
      )
        onExpandedChange(false)
    })
  }
  useEffect(
    () => () => {
      if (blurFrame.current !== null) cancelAnimationFrame(blurFrame.current)
    },
    []
  )
  useLayoutEffect(() => {
    if (expanded && focusOnExpand.current) {
      inputRef.current?.focus()
      focusOnExpand.current = false
    } else if (!expanded && returnFocus.current) {
      searchRef.current?.focus()
      returnFocus.current = false
    }
  }, [expanded])

  return (
    <div
      ref={rootRef}
      data-slot="downloads-search"
      data-expanded={expanded}
      data-filter-active={active}
      onBlurCapture={(event) => {
        // Portal blur events bubble through React too. A closing popup hands
        // focus back to its trigger after its animation; let it finish.
        if (!open && rootRef.current?.contains(event.target)) collapseIfIdle()
      }}
      className={cn(
        'app-no-drag toolbar-glass-surface flex h-9 shrink-0 items-center rounded-full border border-border/70 bg-background/70 p-0.5 transition-[width] duration-150 ease-out motion-reduce:transition-none compact-header:h-[30px]',
        expanded &&
          'has-[input:focus]:border-[#7388a3] dark:has-[input:focus]:border-[#97aac4]'
      )}
      style={{ width: expanded ? width : compact ? 30 : 36 }}
    >
      <ToolbarGlass enabled={glassEnabled} />
      {expanded ? (
        <>
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
                <ListFilter className="size-4" />
              </TooltipTrigger>
              <TooltipContent
                anchor={rootRef}
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
              anchor={rootRef}
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
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            inputMode="search"
            aria-label={label}
            placeholder={label}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onFocus={() => onExpandedChange(true)}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || event.nativeEvent.isComposing)
                return
              event.preventDefault()
              event.stopPropagation()
              if (query) onQueryChange('')
              else if (types.length === 0) {
                returnFocus.current = true
                onExpandedChange(false)
              } else filterRef.current?.focus()
            }}
            className="h-[30px] w-full min-w-0 border-0 bg-transparent px-1 text-[13px] outline-none placeholder:text-muted-foreground compact-header:h-6 compact-header:text-xs"
          />
          {query.length > 0 && (
            <DownloadsToolbarButton
              aria-label={t('panel.downloads.search.clearQuery')}
              title={t('panel.downloads.search.clearQuery')}
              onClick={() => {
                onQueryChange('')
                inputRef.current?.focus()
              }}
            >
              <CircleX className="size-3.5" />
            </DownloadsToolbarButton>
          )}
        </>
      ) : (
        <Tooltip>
          <TooltipTrigger
            delay={400}
            render={
              <DownloadsToolbarButton
                ref={searchRef}
                aria-label={label}
                aria-expanded={false}
                aria-controls={inputId}
                onClick={() => {
                  focusOnExpand.current = true
                  onExpandedChange(true)
                }}
              />
            }
          >
            <Search className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" sideOffset={8}>
            {label}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
