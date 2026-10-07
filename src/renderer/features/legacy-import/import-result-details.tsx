import { VirtualList } from '@renderer/components/desktop-kit/virtual-list/virtual-list'
import { ChevronDownIcon, ChevronRightIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import type { LegacyImportReport } from '@shared/schemas/legacy-import'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImportTaskInfo } from './import-task-info'

export function ImportResultDetails({
  report,
  busy,
  exportReport,
}: {
  report: LegacyImportReport
  busy: boolean
  exportReport: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const row = (item: LegacyImportReport['items'][number]) => (
    <div
      data-import-result={item.itemId}
      className="flex h-16 items-center justify-between gap-3 border-t border-border/70 px-4 py-1"
      key={item.itemId}
    >
      <ImportTaskInfo item={item} />
      <span
        className={
          item.outcome === 'failed'
            ? 'shrink-0 text-xs text-destructive'
            : 'shrink-0 text-xs text-muted-foreground'
        }
      >
        {t(`legacyImport.page.outcomes.${item.outcome}`)}
      </span>
    </div>
  )
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={`mt-3 flex min-h-0 flex-col overflow-hidden rounded-lg border border-border/80 text-xs ${open ? 'flex-1' : 'shrink-0'}`}
    >
      <CollapsibleTrigger
        render={<Button variant="ghost" size="sm" />}
        className="h-11 w-full shrink-0 justify-between rounded-none px-4 text-xs"
      >
        {t('legacyImport.details')}
        {open ? (
          <ChevronDownIcon aria-hidden="true" />
        ) : (
          <ChevronRightIcon aria-hidden="true" className="rtl:rotate-180" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex min-h-0 flex-1 flex-col">
        {open && (
          <>
            {report.items.length > 100 ? (
              <VirtualList
                items={report.items}
                getId={(item) => item.itemId}
                rowHeight={64}
                className="min-h-0 flex-1"
                keepMountedIndex={report.items.findIndex(
                  (item) => item.itemId === focusedId
                )}
                containerProps={{
                  onFocusCapture: (event) => {
                    const item = (
                      event.target as HTMLElement
                    ).closest<HTMLElement>('[data-import-result]')
                    if (item) setFocusedId(item.dataset.importResult ?? null)
                  },
                }}
                renderRow={({ item }) => row(item)}
              />
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                {report.items.map(row)}
              </div>
            )}
            <div className="shrink-0 border-t border-border/70 px-4 py-3">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={exportReport}
              >
                {t('legacyImport.exportReport')}
              </Button>
            </div>
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
