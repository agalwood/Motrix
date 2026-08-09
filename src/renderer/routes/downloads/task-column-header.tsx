import { Checkbox } from '@renderer/components/ui/checkbox'
import { useTranslation } from 'react-i18next'

export interface TaskColumnHeaderProps {
  headerCheckbox: {
    checked: boolean
    indeterminate: boolean
    onChange: () => void
  }
}

export const TASK_GRID_TEMPLATE =
  '28px minmax(180px,2.2fr) 80px 130px 90px 90px 80px 72px 90px'

// Fixed tracks + the name track's minimum + gaps + horizontal padding.
// Keeping the grid box at least this wide makes its background and borders
// cover the full horizontal scroll range on compact viewports.
export const TASK_GRID_MIN_WIDTH = 960

export function TaskColumnHeader({ headerCheckbox }: TaskColumnHeaderProps) {
  const { t } = useTranslation()
  return (
    <div
      className="sticky top-0 z-10 grid items-center gap-3 border-b border-border bg-muted/40 px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground"
      style={{
        gridTemplateColumns: TASK_GRID_TEMPLATE,
        minWidth: TASK_GRID_MIN_WIDTH,
      }}
    >
      <Checkbox
        checked={headerCheckbox.checked}
        indeterminate={headerCheckbox.indeterminate}
        onCheckedChange={headerCheckbox.onChange}
      />
      <span>{t('panel.downloads.column.name')}</span>
      <span className="tabular-nums">{t('panel.downloads.column.size')}</span>
      <span>{t('panel.downloads.column.progress')}</span>
      <span>{t('panel.downloads.column.status')}</span>
      <span className="tabular-nums">{t('panel.downloads.column.down')}</span>
      <span className="tabular-nums">{t('panel.downloads.column.up')}</span>
      <span>{t('panel.downloads.column.eta')}</span>
      <span className="tabular-nums">
        {t('panel.downloads.column.connections')}
      </span>
    </div>
  )
}
