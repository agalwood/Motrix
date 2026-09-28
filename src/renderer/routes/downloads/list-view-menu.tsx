import { ColumnsIcon, InfoIcon } from '@renderer/components/icons'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import type { Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { DownloadsToolbarButton } from './downloads-toolbar-button'
import {
  DEFAULT_TASK_SORT,
  nextTaskSort,
  TASK_SORT_COLUMNS,
  type TaskSortColumn,
} from './sort'
import { useDownloadsSort } from './store'
import type { TaskMenuShortcut } from './task-menu-shortcuts'
import { useDownloadsView } from './view-preferences'

export function ColumnVisibilityItems() {
  const { t } = useTranslation()
  const columns = useDownloadsView((state) => state.columns)
  const setVisible = useDownloadsView((state) => state.setColumnVisible)
  const reset = useDownloadsView((state) => state.resetColumns)
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>
          {t('panel.downloads.view.columns')}
        </DropdownMenuLabel>
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.visible}
            disabled={column.id === 'name'}
            closeOnClick={false}
            onCheckedChange={(visible) => setVisible(column.id, visible)}
          >
            {t(`panel.downloads.column.${column.id}`)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={reset}>
        {t('panel.downloads.view.resetColumns')}
      </DropdownMenuItem>
    </>
  )
}

export function ListViewMenuItems() {
  const { t } = useTranslation()
  const sort = useDownloadsSort((state) => state.sort)
  const setSort = useDownloadsSort((state) => state.setSort)
  const resetSort = useDownloadsSort((state) => state.resetSort)
  const effective = sort ?? DEFAULT_TASK_SORT
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          {t('panel.downloads.view.sortBy')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent data-menu-density="compact">
          <DropdownMenuRadioGroup
            value={effective.column}
            onValueChange={(column) =>
              setSort(nextTaskSort(null, column as TaskSortColumn))
            }
          >
            {TASK_SORT_COLUMNS.map((column) => (
              <DropdownMenuRadioItem key={column} value={column}>
                {t(`panel.downloads.column.${column}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={effective.direction}
            onValueChange={(direction) =>
              setSort({
                column: effective.column,
                direction: direction as 'asc' | 'desc',
              })
            }
          >
            <DropdownMenuRadioItem value="asc">
              {t('panel.downloads.view.ascending')}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="desc">
              {t('panel.downloads.view.descending')}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem onClick={resetSort}>
        {t('panel.downloads.sort.reset')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <ColumnVisibilityItems />
    </>
  )
}

export function ListViewSubmenu() {
  const { t } = useTranslation()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {t('panel.downloads.view.title')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent data-menu-density="compact">
        <ListViewMenuItems />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export function ListViewMenu({
  onOpenChange,
  triggerRef,
}: {
  onOpenChange?: (open: boolean) => void
  triggerRef?: Ref<HTMLButtonElement>
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <DownloadsToolbarButton
            ref={triggerRef}
            aria-label={t('panel.downloads.view.title')}
            title={t('panel.downloads.view.title')}
          />
        }
      >
        <ColumnsIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-menu-density="compact">
        <ListViewMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function InspectorMenuItem({
  visible,
  disabled,
  onHide,
  onShow,
  shortcut,
}: {
  visible: boolean
  disabled: boolean
  onHide?: () => void
  onShow?: () => void
  shortcut?: TaskMenuShortcut
}) {
  const { t } = useTranslation()
  const setVisible = useDownloadsView((state) => state.setInspectorVisible)
  return (
    <DropdownMenuItem
      disabled={disabled}
      title={disabled ? t('panel.downloads.view.selectToInspect') : undefined}
      aria-keyshortcuts={shortcut?.aria}
      onClick={() => {
        if (visible) onHide?.()
        else onShow?.()
        setVisible(!visible)
      }}
    >
      {t(`panel.downloads.view.${visible ? 'hideInspector' : 'showInspector'}`)}
      {shortcut && (
        <DropdownMenuShortcut aria-hidden="true">
          {shortcut.label}
        </DropdownMenuShortcut>
      )}
    </DropdownMenuItem>
  )
}

export function InspectorToggle({
  visible,
  disabled,
  onHide,
  triggerRef,
}: {
  visible: boolean
  disabled: boolean
  onHide?: () => void
  triggerRef?: Ref<HTMLButtonElement>
}) {
  const { t } = useTranslation()
  const setVisible = useDownloadsView((state) => state.setInspectorVisible)
  const label = t(
    `panel.downloads.view.${visible ? 'hideInspector' : 'showInspector'}`
  )
  return (
    <DownloadsToolbarButton
      ref={triggerRef}
      aria-label={label}
      title={disabled ? t('panel.downloads.view.selectToInspect') : label}
      disabled={disabled}
      aria-pressed={visible}
      onClick={() => {
        if (visible) onHide?.()
        setVisible(!visible)
      }}
    >
      <InfoIcon className="size-4" />
    </DownloadsToolbarButton>
  )
}
