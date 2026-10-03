import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import {
  ArrowRightIcon,
  CheckIcon,
  DownloadLibraryIcon,
  FolderIcon,
  HttpIcon,
  LockedIcon,
  MagnetIcon,
  type MotrixIcon,
  TorrentFileIcon,
} from '@renderer/components/icons'
import { cn } from '@renderer/lib/utils'
import type {
  LegacyImportItem,
  LegacyImportPreview,
  LegacyImportReport,
} from '@shared/schemas/legacy-import'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export type ImportStage = 'discovery' | 'selection' | 'progress' | 'result'

const steps = ['select', 'import', 'result'] as const
const taskTypes: Array<{ type: LegacyImportItem['type']; icon: MotrixIcon }> = [
  { type: 'http', icon: HttpIcon },
  { type: 'bt', icon: TorrentFileIcon },
  { type: 'magnet', icon: MagnetIcon },
  { type: 'unknown', icon: DownloadLibraryIcon },
]

export function ImportSteps({ stage }: { stage: ImportStage }) {
  const { t } = useTranslation()
  const current = stage === 'result' ? 2 : stage === 'progress' ? 1 : 0
  return (
    <ol
      aria-label={t('legacyImport.page.stepsLabel')}
      className="mx-auto flex w-full max-w-2xl items-center py-1"
    >
      {steps.map((step, index) => (
        <li
          key={step}
          aria-current={index === current ? 'step' : undefined}
          className={cn('flex items-center', index < 2 && 'flex-1')}
        >
          <div
            className={cn(
              'flex shrink-0 items-center gap-2 text-xs',
              index === current ? 'font-medium' : 'text-muted-foreground'
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex size-6 items-center justify-center rounded-full border text-[11px] tabular-nums transition-colors motion-reduce:transition-none',
                index === current &&
                  'border-primary bg-primary text-primary-foreground',
                index < current &&
                  'border-transparent bg-muted text-foreground',
                index > current && 'border-border/70'
              )}
            >
              {index < current ? <CheckIcon className="size-3" /> : index + 1}
            </span>
            <span
              className={cn(
                index !== current && 'sr-only @[480px]/import:not-sr-only'
              )}
            >
              {t(`legacyImport.page.steps.${step}`)}
            </span>
          </div>
          {index < 2 && (
            <span
              aria-hidden="true"
              className="mx-3 h-px flex-1 bg-border/70"
            />
          )}
        </li>
      ))}
    </ol>
  )
}

/** A quiet, static illustration; the process itself never moves source files. */
export function ImportTransferIllustration() {
  const { t } = useTranslation()
  return (
    <div
      aria-hidden="true"
      className="flex items-center justify-center gap-5 py-5"
    >
      <div className="space-y-3 text-center">
        <div className="flex size-18 items-center justify-center rounded-[22px] border border-border/70 bg-gradient-to-b from-background to-muted/70 shadow-sm">
          <FolderIcon
            className="size-8 text-muted-foreground"
            strokeWidth={1.35}
          />
        </div>
        <span className="text-[11px] text-muted-foreground">
          {t('legacyImport.page.previousVersion')}
        </span>
      </div>
      <ArrowRightIcon className="mb-6 size-5 text-muted-foreground/60 rtl:rotate-180" />
      <div className="space-y-3 text-center">
        <div className="flex size-18 items-center justify-center rounded-[22px] border border-border/70 bg-background shadow-sm">
          <DownloadLibraryIcon className="size-8" strokeWidth={1.35} />
        </div>
        <span className="text-[11px] font-medium">
          {t('legacyImport.page.currentVersion')}
        </span>
      </div>
    </div>
  )
}

function ImportOverview({
  stage,
  preview,
  selected,
  report,
}: {
  stage: ImportStage
  preview: LegacyImportPreview | null
  selected: ReadonlySet<string>
  report: LegacyImportReport | null
}) {
  const { t } = useTranslation()
  const items =
    preview?.items.filter(
      (item) => stage === 'discovery' || selected.has(item.itemId)
    ) ?? []
  return (
    <aside className="hidden min-h-0 flex-col gap-4 overflow-y-auto @[660px]/import:flex">
      <section className="rounded-2xl bg-muted/45 p-4">
        <h2 className="text-xs font-medium">
          {t(
            `legacyImport.page.${stage === 'result' ? 'resultSummary' : stage === 'discovery' ? 'foundSummary' : 'selectionSummary'}`
          )}
        </h2>
        {(stage === 'selection' || stage === 'progress') && (
          <p className="mt-2 text-4xl font-semibold tracking-tight tabular-nums">
            {preview ? items.length : '—'}
            <span className="ms-2 text-xs font-normal tracking-normal text-muted-foreground">
              {t('legacyImport.page.countUnit')}
            </span>
          </p>
        )}
        <dl className="mt-4 space-y-2.5">
          {stage === 'result' && report ? (
            <>
              <SummaryRow
                label={t('legacyImport.page.notImported')}
                value={
                  report.items.filter(
                    (item) =>
                      item.outcome === 'failed' ||
                      item.outcome === 'unprocessed'
                  ).length
                }
              />
              <SummaryRow
                label={t('legacyImport.page.skippedSummary')}
                value={
                  report.items.filter((item) => item.outcome === 'skipped')
                    .length
                }
              />
            </>
          ) : (
            taskTypes.map(({ type, icon: Icon }) => {
              const count = items.filter((item) => item.type === type).length
              if (!count) return null
              return (
                <div key={type} className="flex items-center gap-2 text-xs">
                  <Icon
                    className="size-3.5 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <dt className="flex-1 text-muted-foreground">
                    {t(`legacyImport.page.types.${type}`)}
                  </dt>
                  <dd className="tabular-nums">{count}</dd>
                </div>
              )
            })
          )}
        </dl>
      </section>
      <section className="px-1">
        <LockedIcon
          className="mb-2 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="text-xs font-medium">
          {t('legacyImport.page.filesStayTitle')}
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t('legacyImport.page.filesStayDescription')}
        </p>
      </section>
      <section className="border-t border-border/60 px-1 pt-4">
        <h2 className="text-xs font-medium">
          {t('legacyImport.page.nextTitle')}
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t('legacyImport.page.nextDescription')}
        </p>
      </section>
    </aside>
  )
}

function SummaryRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

export function ImportPageLayout({
  title,
  stage,
  preview,
  selected,
  report,
  footer,
  children,
}: {
  title: string
  stage: ImportStage
  preview: LegacyImportPreview | null
  selected: ReadonlySet<string>
  report: LegacyImportReport | null
  footer: ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <PanelShell
      title={title}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('legacyImport.page.footerNote')}
          </p>
          <div className="ms-auto">{footer}</div>
        </div>
      }
    >
      <div className="@container/import flex min-h-0 flex-1 flex-col">
        <p className="shrink-0 px-6 pb-5 text-sm leading-relaxed text-muted-foreground">
          {t('legacyImport.page.introduction')}
        </p>
        <div className="shrink-0 px-6 pb-5 pt-1">
          <ImportSteps stage={stage} />
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 px-6 pb-3 @[660px]/import:grid-cols-[minmax(0,1fr)_184px]">
          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-xs">
            {children}
          </div>
          <ImportOverview
            stage={stage}
            preview={preview}
            selected={selected}
            report={report}
          />
        </div>
      </div>
    </PanelShell>
  )
}
