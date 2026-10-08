import { VirtualList } from '@renderer/components/desktop-kit/virtual-list/virtual-list'
import { ChevronDownIcon, ChevronRightIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import type { LegacyImportReport } from '@shared/schemas/legacy-import'
import { useMemo, useState } from 'react'
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
  // Unselected tasks are outside this run. Put unfinished work first without
  // changing the source report, which is exported in full.
  const items = useMemo(
    () =>
      report.items
        .filter((item) => item.reason !== 'not-selected')
        .sort(
          (a, b) =>
            Number(b.outcome === 'failed' || b.outcome === 'unprocessed') -
            Number(a.outcome === 'failed' || a.outcome === 'unprocessed')
        ),
    [report.items]
  )
  const row = (item: LegacyImportReport['items'][number]) => (
    <div
      data-import-result={item.itemId}
      className="flex h-16 items-center justify-between gap-3 border-t border-border/70 px-4 py-1"
      key={item.itemId}
    >
      <ImportTaskInfo item={item} showReason={item.outcome !== 'imported'} />
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
      className={`migration-result-details mt-5 flex min-h-0 flex-col overflow-hidden text-xs ${open ? 'flex-1' : 'shrink-0'}`}
    >
      <CollapsibleTrigger
        render={<Button variant="ghost" size="sm" />}
        className="w-fit shrink-0 justify-start gap-1.5 px-0 has-[>svg]:px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
      >
        {t('legacyImport.details')}
        {open ? (
          <ChevronDownIcon aria-hidden="true" />
        ) : (
          <ChevronRightIcon aria-hidden="true" className="rtl:rotate-180" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 flex max-h-80 min-h-0 flex-1 flex-col overflow-hidden border-x border-b border-border/70">
        {open && (
          <>
            {items.length > 100 ? (
              <VirtualList
                items={items}
                getId={(item) => item.itemId}
                rowHeight={64}
                className="min-h-0 flex-1"
                keepMountedIndex={items.findIndex(
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
                {items.map(row)}
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
