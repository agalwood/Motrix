import { CheckIcon } from '@renderer/components/icons'
import { Progress } from '@renderer/components/ui/progress'
import { Spinner } from '@renderer/components/ui/spinner'
import type { LegacyImportReport } from '@shared/schemas/legacy-import'
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ImportStageHeading } from './import-page-layout'
import { ImportResultDetails } from './import-result-details'

function RunStep({
  title,
  description,
  state,
  children,
}: {
  title: string
  description: string
  state: 'active' | 'done' | 'waiting'
  children?: ReactNode
}) {
  return (
    <li
      className="migration-run-step relative flex gap-3"
      aria-current={state === 'active' ? 'step' : undefined}
    >
      <span
        aria-hidden="true"
        className="relative z-1 flex size-6 shrink-0 items-center justify-center bg-background"
      >
        {state === 'done' ? (
          <CheckIcon className="size-4" />
        ) : state === 'active' ? (
          <Spinner aria-hidden="true" className="size-4" />
        ) : (
          <span className="size-2 rounded-full bg-muted-foreground/30" />
        )}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p
          className={`text-sm leading-5 ${state === 'waiting' ? 'text-muted-foreground' : 'font-medium'}`}
        >
          {title}
        </p>
        <p className="mt-1 text-xs leading-5 tabular-nums text-muted-foreground">
          {description}
        </p>
        {children}
      </div>
    </li>
  )
}

export function ImportRunProgress({
  report,
  notice,
}: {
  report: LegacyImportReport | null
  notice?: ReactNode
}) {
  const { t } = useTranslation()
  const committing = report?.stage === 'committing'
  const fraction =
    report && report.total > 0
      ? Math.min(1, Math.max(0, report.processed / report.total))
      : 0
  return (
    <div className="migration-run-content flex min-h-0 flex-col py-6">
      <ImportStageHeading
        title={t('legacyImport.page.progressTitle')}
        description={t('legacyImport.preserveFiles')}
        className="pt-0 pb-8"
      />
      {notice}
      <span className="sr-only" role="status">
        {t(committing ? 'legacyImport.committing' : 'legacyImport.backingUp')}
      </span>
      <ol className="space-y-7" aria-label={t('legacyImport.page.stepsLabel')}>
        <RunStep
          title={t('legacyImport.page.run.backup')}
          description={t(
            report?.backupCreated
              ? 'legacyImport.page.run.backupDone'
              : 'legacyImport.page.run.backupActive'
          )}
          state={report?.backupCreated ? 'done' : 'active'}
        />
        <RunStep
          title={t('legacyImport.page.run.add')}
          description={
            committing
              ? t('legacyImport.processed', {
                  done: report.processed,
                  total: report.total,
                })
              : t('legacyImport.page.run.waiting')
          }
          state={committing ? 'active' : 'waiting'}
        >
          <Progress
            value={committing ? fraction * 100 : undefined}
            className="mt-4 h-1"
            aria-label={t('legacyImport.progress')}
            aria-valuetext={
              committing
                ? t('legacyImport.processed', {
                    done: report.processed,
                    total: report.total,
                  })
                : t('legacyImport.backingUp')
            }
            indicatorClassName={
              committing ? 'migration-progress-fill w-full!' : 'invisible'
            }
            style={{ '--migration-progress': fraction } as CSSProperties}
          />
        </RunStep>
      </ol>
    </div>
  )
}

export function ImportRunResult({
  report,
  busy,
  notice,
  exportReport,
}: {
  report: LegacyImportReport
  busy: boolean
  notice?: ReactNode
  exportReport: () => void
}) {
  const { t } = useTranslation()
  const remaining = report.items.filter(
    (item) => item.outcome === 'failed' || item.outcome === 'unprocessed'
  ).length
  const skipped = report.items.filter(
    (item) => item.outcome === 'skipped' && item.reason !== 'not-selected'
  ).length
  const titleKey =
    report.stage === 'cancelled'
      ? 'legacyImport.resultStoppedTitle'
      : report.stage === 'failed' || remaining > 0
        ? 'legacyImport.resultIncompleteTitle'
        : report.imported === 0
          ? 'legacyImport.page.resultEmptyTitle'
          : 'legacyImport.resultTitle'
  const descriptionKey =
    report.imported > 0
      ? remaining > 0
        ? 'legacyImport.page.run.partialDescription'
        : 'legacyImport.page.run.completeDescription'
      : report.stage === 'cancelled'
        ? 'legacyImport.page.run.stoppedEmptyDescription'
        : report.stage === 'failed' || remaining > 0
          ? 'legacyImport.page.run.failedEmptyDescription'
          : 'legacyImport.page.resultEmptyDescription'
  return (
    <div className="migration-run-content flex min-h-0 flex-col py-6">
      <ImportStageHeading
        title={t(titleKey)}
        description={t(descriptionKey)}
        className="pt-0 pb-8"
      />
      {notice}
      <dl
        aria-label={t('legacyImport.page.resultSummary')}
        className="shrink-0 divide-y divide-border/70 border-y border-border/70 text-sm"
      >
        <div className="flex items-center justify-between gap-4 py-4">
          <dt>{t('legacyImport.page.run.imported')}</dt>
          <dd className="flex items-center gap-2 tabular-nums">
            {report.imported > 0 && (
              <CheckIcon
                aria-hidden="true"
                className="size-3.5 text-muted-foreground"
              />
            )}
            <span>
              {t('legacyImport.page.groupCount', { count: report.imported })}
            </span>
          </dd>
        </div>
        {remaining > 0 && (
          <div className="flex items-center justify-between gap-4 py-4">
            <dt>{t('legacyImport.page.run.remaining')}</dt>
            <dd className="tabular-nums">
              {t('legacyImport.page.groupCount', { count: remaining })}
            </dd>
          </div>
        )}
        {skipped > 0 && (
          <div className="flex items-center justify-between gap-4 py-4">
            <dt>{t('legacyImport.page.skippedSummary')}</dt>
            <dd className="tabular-nums">
              {t('legacyImport.page.groupCount', { count: skipped })}
            </dd>
          </div>
        )}
      </dl>
      <p className="mt-4 shrink-0 text-xs leading-5 text-muted-foreground">
        {t('legacyImport.preserveFiles')}
      </p>
      <ImportResultDetails
        report={report}
        busy={busy}
        exportReport={exportReport}
      />
    </div>
  )
}
