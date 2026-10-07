import { CheckIcon, FolderIcon, WarningIcon } from '@renderer/components/icons'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Progress } from '@renderer/components/ui/progress'
import { Spinner } from '@renderer/components/ui/spinner'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@renderer/components/ui/toggle-group'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  type LegacyImportItem,
  type LegacyImportPreview,
  type LegacyImportReport,
  type LegacyImportSource,
  legacyImportPreviewSchema,
  legacyImportReportSchema,
  legacyImportSourceSchema,
} from '@shared/schemas/legacy-import'
import {
  Component,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { ImportMotionScope, ImportResultMark } from './import-motion'
import {
  ImportPageLayout,
  type ImportStage,
  ImportStageHeading,
} from './import-page-layout'
import { ImportResultDetails } from './import-result-details'
import {
  ImportTaskSelection,
  initialExpandedGroups,
} from './import-task-selection'

interface Props {
  open: boolean
  invitation?: boolean
  onClose: () => void
  onViewTasks?: () => void
  presentation?: 'dialog' | 'page'
  active?: boolean
}
const terminal = (report: LegacyImportReport) =>
  ['completed', 'cancelled', 'failed'].includes(report.stage)

class ImportErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function LegacyImportDialog(props: Props) {
  const { t } = useTranslation()
  return (
    <ImportErrorBoundary
      fallback={<p role="alert">{t('legacyImport.errors.failed')}</p>}
    >
      <LegacyImportDialogContent {...props} />
    </ImportErrorBoundary>
  )
}

function LegacyImportDialogContent({
  open,
  invitation = false,
  onClose,
  onViewTasks,
  presentation = 'dialog',
  active = true,
}: Props) {
  const { t } = useTranslation()
  const page = presentation === 'page'
  const [stage, setStage] = useState<ImportStage>('discovery')
  const [preview, setPreview] = useState<LegacyImportPreview | null>(null)
  const previewRef = useRef<LegacyImportPreview | null>(null)
  const [sources, setSources] = useState<LegacyImportSource[]>([])
  const [sourceHandle, setSourceHandle] = useState<string | null>(null)
  const sourceHandleRef = useRef<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<LegacyImportItem['type']>>(
    new Set()
  )
  const [report, setReport] = useState<LegacyImportReport | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [confirmStop, setConfirmStop] = useState(false)
  const epoch = useRef(0)
  const runId = report?.runId
  const finished = report ? terminal(report) : false
  const resultTitleKey =
    report?.stage === 'cancelled'
      ? 'legacyImport.resultStoppedTitle'
      : report?.stage === 'failed' ||
          report?.items.some(
            (item) =>
              item.outcome === 'failed' || item.outcome === 'unprocessed'
          )
        ? 'legacyImport.resultIncompleteTitle'
        : report?.stage === 'completed' && report.imported === 0
          ? 'legacyImport.page.resultEmptyTitle'
          : 'legacyImport.resultTitle'
  const resultDescriptionKey =
    resultTitleKey === 'legacyImport.resultStoppedTitle'
      ? 'legacyImport.page.resultStoppedDescription'
      : resultTitleKey === 'legacyImport.resultIncompleteTitle'
        ? 'legacyImport.page.resultIncompleteDescription'
        : resultTitleKey === 'legacyImport.page.resultEmptyTitle'
          ? 'legacyImport.page.resultEmptyDescription'
          : 'legacyImport.resultDescription'

  const failure = useCallback(
    (cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause)
      const found = message.match(/legacyImport\.(?:errors\.)?[a-zA-Z]+/)?.[0]
      const key = found?.includes('.errors.')
        ? found
        : found
          ? `legacyImport.errors.${found.split('.').at(-1)}`
          : undefined
      setError(key && t(key) !== key ? t(key) : t('legacyImport.errors.failed'))
    },
    [t]
  )
  const failureRef = useRef(failure)
  useEffect(() => {
    failureRef.current = failure
  }, [failure])

  const perform = useCallback(async (operation: () => Promise<void>) => {
    if (busyRef.current) return
    const generation = epoch.current
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      if (generation === epoch.current) failureRef.current(cause)
    } finally {
      if (generation === epoch.current) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }, [])

  const scan = useCallback(
    async (source: LegacyImportSource, refresh = false) => {
      const generation = epoch.current
      const sameSource = source.sourceHandle === sourceHandleRef.current
      const preserveSelection = sameSource && previewRef.current !== null
      if (sameSource && previewRef.current && !refresh) return
      sourceHandleRef.current = source.sourceHandle
      setSourceHandle(source.sourceHandle)
      if (!sameSource) {
        previewRef.current = null
        setPreview(null)
        setSelected(new Set())
        setExpanded(new Set())
        setQuery('')
      }
      const next = legacyImportPreviewSchema.parse(
        await transport.invoke(Queries.ScanLegacyImport, {
          sourceHandle: source.sourceHandle,
        })
      )
      if (generation !== epoch.current) return
      previewRef.current = next
      setPreview(next)
      setSelected(
        (current) =>
          new Set(
            next.items
              .filter(
                (item) =>
                  item.selectable &&
                  (!preserveSelection || current.has(item.itemId))
              )
              .map((item) => item.itemId)
          )
      )
      if (!preserveSelection) setExpanded(initialExpandedGroups(next.items))
      setError(null)
    },
    []
  )

  const discover = useCallback(async () => {
    const generation = epoch.current
    const result = await transport.invoke(Queries.DiscoverLegacyImport)
    if (generation !== epoch.current) return
    const found = (result as unknown[]).map((source) =>
      legacyImportSourceSchema.parse(source)
    )
    setSources(found)
    if (found[0]) await scan(found[0])
  }, [scan])

  useEffect(() => {
    if (!open) return
    ++epoch.current
    setStage('discovery')
    previewRef.current = null
    sourceHandleRef.current = null
    setPreview(null)
    setSourceHandle(null)
    setSources([])
    setReport(null)
    setSelected(new Set())
    setExpanded(new Set())
    setQuery('')
    setConfirmStop(false)
    void perform(discover)
    return () => {
      epoch.current++
      busyRef.current = false
    }
  }, [open, perform, discover])

  const receiveReport = useCallback((next: LegacyImportReport) => {
    setReport((current) => {
      if (
        current?.runId === next.runId &&
        ((terminal(current) && !terminal(next)) ||
          current.processed > next.processed)
      )
        return current
      return next
    })
    if (terminal(next)) setStage('result')
  }, [])

  useEffect(() => {
    if (!open || !runId || finished) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      try {
        const next = legacyImportReportSchema.parse(
          await transport.invoke(Queries.GetLegacyImportRun, { runId })
        )
        if (disposed) return
        receiveReport(next)
        if (terminal(next)) return
        setError(null)
      } catch (cause) {
        if (!disposed) failure(cause)
      }
      if (!disposed) timer = setTimeout(() => void poll(), 250)
    }
    timer = setTimeout(() => void poll(), 250)
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [open, runId, finished, failure, receiveReport])

  const pickSource = () =>
    void perform(async () => {
      const generation = epoch.current
      const result = await transport.invoke(Commands.PickLegacyImportSource)
      if (!result || generation !== epoch.current) return
      const source = legacyImportSourceSchema.parse(result)
      setSources((current) =>
        current.some((entry) => entry.sourceHandle === source.sourceHandle)
          ? current
          : [...current, source]
      )
      await scan(source)
    })
  const recheck = () =>
    void perform(async () => {
      const source = sources.find(
        (entry) => entry.sourceHandle === sourceHandle
      )
      if (source) await scan(source, true)
      else await discover()
    })
  const chooseTorrent = (item: LegacyImportItem) =>
    void perform(async () => {
      if (!preview) return
      const generation = epoch.current
      const result = await transport.invoke(
        Commands.PickLegacyTorrentMetadata,
        { previewId: preview.previewId, itemId: item.itemId }
      )
      if (!result || generation !== epoch.current) return
      const next = legacyImportPreviewSchema.parse(result)
      previewRef.current = next
      setPreview(next)
      setSelected(
        (current) =>
          new Set(
            next.items
              .filter(
                (entry) =>
                  entry.selectable &&
                  (current.has(entry.itemId) || entry.itemId === item.itemId)
              )
              .map((entry) => entry.itemId)
          )
      )
    })
  const leave = () =>
    void perform(async () => {
      const generation = epoch.current
      if (invitation)
        await transport.invoke(Commands.DismissLegacyImportInvitation)
      if (generation === epoch.current) onClose()
    })
  const viewTasks = () =>
    void perform(async () => {
      const generation = epoch.current
      await transport.invoke(Commands.FinishLegacyImportInvitation)
      if (generation === epoch.current) (onViewTasks ?? onClose)()
    })
  const startImport = () =>
    void perform(async () => {
      if (!preview || !selected.size || preview.running) return
      const generation = epoch.current
      setStage('progress')
      try {
        const next = legacyImportReportSchema.parse(
          await transport.invoke(Commands.CommitLegacyImport, {
            previewId: preview.previewId,
            itemIds: [...selected],
          })
        )
        if (generation !== epoch.current) return
        receiveReport(next)
      } catch (cause) {
        if (generation !== epoch.current) return
        setStage('selection')
        throw cause
      }
    })
  const retry = () =>
    void perform(async () => {
      if (!report) return
      const generation = epoch.current
      const next = legacyImportReportSchema.parse(
        await transport.invoke(Commands.RetryLegacyImport, {
          runId: report.runId,
        })
      )
      if (generation !== epoch.current) return
      setReport(next)
      setStage(terminal(next) ? 'result' : 'progress')
    })
  const onBack = () => {
    if (busyRef.current || stage === 'progress') return
    if (stage === 'selection') setStage('discovery')
    else if (stage === 'result') viewTasks()
    else leave()
  }
  const primaryClass = 'migration-primary min-w-28'
  const footer = (
    <div className="flex w-full items-center justify-between gap-3">
      {(stage === 'discovery' || stage === 'selection') && (
        <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={leave}>
            {t('legacyImport.skip')}
          </Button>
          {stage === 'discovery' ? (
            <Button
              size="sm"
              className={primaryClass}
              disabled={
                busy || !preview || preview.sourceHandle !== sourceHandle
              }
              onClick={() => setStage('selection')}
            >
              {t('legacyImport.page.continue')}
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={onBack}
              >
                {t('legacyImport.page.backToSource')}
              </Button>
              <Button
                size="sm"
                className={primaryClass}
                disabled={busy || !selected.size || preview?.running}
                onClick={(event) => {
                  // A double-click on Continue must not commit the next stage.
                  if (event.detail < 2) startImport()
                }}
              >
                {t('legacyImport.importSelected', { count: selected.size })}
              </Button>
            </div>
          )}
        </>
      )}
      {stage === 'progress' && (
        <>
          <span className="text-xs text-muted-foreground">
            {t('legacyImport.page.footerNote')}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!report || busy}
            onClick={() => setConfirmStop(true)}
          >
            {t('legacyImport.stop')}
          </Button>
        </>
      )}
      {stage === 'result' && (
        <>
          {report?.items.some(
            (item) =>
              item.outcome === 'failed' || item.outcome === 'unprocessed'
          ) ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={retry}>
              {t('legacyImport.retry')}
            </Button>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            className={primaryClass}
            disabled={busy}
            onClick={viewTasks}
          >
            {t('legacyImport.viewTasks')}
          </Button>
        </>
      )}
    </div>
  )
  const errorNotice = error && (
    <Alert
      variant="destructive"
      className="mx-auto mb-3 w-full max-w-160 shrink-0"
    >
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <p className="min-w-0 flex-1">{error}</p>
        {(stage === 'discovery' || stage === 'selection') && (
          <Button variant="outline" size="sm" disabled={busy} onClick={recheck}>
            {t('legacyImport.recheck')}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
  const content = (
    <>
      {stage === 'discovery' && (
        <>
          <ImportStageHeading
            title={t('legacyImport.page.sourceTitle')}
            description={t('legacyImport.page.sourceIntroduction')}
          />
          {errorNotice}
          <div className="mx-auto min-h-0 w-full max-w-160 flex-1 overflow-auto py-3">
            {sources.length > 0 && (
              <ToggleGroup
                multiple={false}
                orientation="vertical"
                value={sourceHandle ? [sourceHandle] : []}
                onValueChange={(values) => {
                  const source = sources.find(
                    (entry) => entry.sourceHandle === values[0]
                  )
                  if (source) void perform(() => scan(source))
                }}
                aria-label={t('legacyImport.source')}
                className="w-full flex-col gap-3 bg-transparent p-0"
              >
                {sources.map((source) => (
                  <ToggleGroupItem
                    key={source.sourceHandle}
                    value={source.sourceHandle}
                    disabled={busy}
                    aria-label={source.name}
                    className="migration-source min-h-22 w-full shrink-0 justify-start gap-4 rounded-lg border border-border/80 px-5 py-4 text-start whitespace-normal data-pressed:shadow-none"
                  >
                    <FolderIcon
                      aria-hidden="true"
                      className="size-8 text-muted-foreground"
                      strokeWidth={1.4}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {source.name}
                      </span>
                      <span className="mt-1 block text-xs font-normal text-muted-foreground">
                        {t('legacyImport.page.sourceKind')}
                      </span>
                    </span>
                    {sourceHandle === source.sourceHandle && (
                      <CheckIcon aria-hidden="true" className="size-5" />
                    )}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            )}
            {busy ? (
              <p
                role="status"
                className="flex items-center gap-2 py-4 text-xs text-muted-foreground"
              >
                <Spinner
                  aria-label={t('legacyImport.loading')}
                  className="size-3.5"
                />
                {t('legacyImport.loading')}
              </p>
            ) : preview ? (
              <p className="py-4 text-xs text-muted-foreground">
                {t(
                  preview.items.length
                    ? 'legacyImport.discovery'
                    : 'legacyImport.empty',
                  { count: preview.items.length }
                )}
              </p>
            ) : (
              !sources.length && (
                <p className="py-5 text-sm leading-relaxed text-muted-foreground">
                  {t('legacyImport.page.noSourceDescription')}
                </p>
              )
            )}
            <div className="flex py-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={pickSource}
              >
                <FolderIcon aria-hidden="true" className="size-4" />
                {t('legacyImport.chooseDestination')}
              </Button>
            </div>
            <p className="mt-3 max-w-md text-xs leading-relaxed text-muted-foreground">
              {t('legacyImport.page.sourceHelp')}
            </p>
          </div>
        </>
      )}
      {stage === 'selection' && (
        <>
          <ImportStageHeading
            title={t('legacyImport.page.selectionTitle')}
            description={t('legacyImport.page.introduction')}
            source={
              preview
                ? t('legacyImport.page.sourceDescription', {
                    name: preview.sourceName,
                  })
                : undefined
            }
          />
          {errorNotice}
          {preview?.running && (
            <Alert className="mx-auto mb-3 w-full max-w-160 shrink-0">
              <WarningIcon aria-hidden="true" />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3 text-xs">
                <span className="min-w-0 flex-1">
                  {t('legacyImport.running')}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={recheck}
                >
                  {t('legacyImport.recheck')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <ImportTaskSelection
            items={preview?.items ?? []}
            selected={selected}
            setSelected={setSelected}
            expanded={expanded}
            setExpanded={setExpanded}
            query={query}
            setQuery={setQuery}
            busy={busy}
            running={preview?.running ?? false}
            chooseTorrent={chooseTorrent}
          />
          <div className="migration-selection-note mx-auto w-full max-w-160 shrink-0 py-4 text-xs leading-relaxed">
            <p>
              {t('legacyImport.page.selectedNote', { count: selected.size })}
            </p>
            <p className="mt-2 text-muted-foreground">
              {t('legacyImport.page.footerNote')}
            </p>
          </div>
        </>
      )}
      {stage === 'progress' && (
        <>
          <ImportStageHeading
            title={t('legacyImport.page.progressTitle')}
            description={t('legacyImport.page.progressDescription')}
          />
          {errorNotice}
          <div className="mx-auto flex min-h-0 w-full max-w-160 flex-1 flex-col pt-5 pb-12">
            <p className="mb-3 text-sm font-medium" aria-live="polite">
              {t(
                report?.stage === 'committing'
                  ? 'legacyImport.committing'
                  : 'legacyImport.backingUp'
              )}
            </p>
            <Progress
              value={
                report
                  ? (report.processed / Math.max(report.total, 1)) * 100
                  : undefined
              }
              aria-label={t('legacyImport.progress')}
              indicatorClassName={
                report ? 'migration-progress-fill w-full!' : 'bg-foreground'
              }
              style={
                report
                  ? ({
                      '--migration-progress': Math.min(
                        1,
                        Math.max(
                          0,
                          report.processed / Math.max(report.total, 1)
                        )
                      ),
                    } as CSSProperties)
                  : undefined
              }
            />
            <p
              className="mt-3 text-xs tabular-nums text-muted-foreground"
              aria-live="polite"
            >
              {t('legacyImport.processed', {
                done: report?.processed ?? 0,
                total: report?.total ?? selected.size,
              })}
            </p>
          </div>
        </>
      )}
      {stage === 'result' && report && (
        <>
          <ImportStageHeading
            title={t(resultTitleKey)}
            description={t(resultDescriptionKey)}
          />
          {errorNotice}
          <div className="mx-auto flex min-h-0 w-full max-w-160 flex-1 flex-col pb-5">
            <div className="flex shrink-0 flex-col items-start py-3">
              <ImportResultMark
                success={resultTitleKey === 'legacyImport.resultTitle'}
              >
                {resultTitleKey === 'legacyImport.resultTitle' ? (
                  <CheckIcon aria-hidden="true" className="size-6" />
                ) : (
                  <WarningIcon aria-hidden="true" className="size-6" />
                )}
              </ImportResultMark>
              <p className="text-sm font-medium tabular-nums">
                {t('legacyImport.importedCount', { count: report.imported })}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {t('legacyImport.page.footerNote')}
              </p>
            </div>
            <ImportResultDetails
              report={report}
              busy={busy}
              exportReport={() =>
                void perform(async () => {
                  await transport.invoke(Commands.ExportLegacyImportReport, {
                    runId: report.runId,
                  })
                })
              }
            />
          </div>
        </>
      )}
    </>
  )
  return (
    <>
      {page ? (
        <ImportPageLayout active={active} stage={stage} footer={footer}>
          {content}
        </ImportPageLayout>
      ) : (
        <Dialog
          open={open}
          onOpenChange={(next, details) => {
            if (!next) {
              if (stage === 'progress' || busy) details.cancel()
              else leave()
            }
          }}
        >
          <DialogContent
            className="flex h-[min(680px,85vh)] flex-col gap-0 p-0 sm:max-w-[720px]"
            initialFocus={false}
          >
            <DialogHeader className="sr-only">
              <DialogTitle>{t('legacyImport.page.assistantTitle')}</DialogTitle>
              <DialogDescription>
                {t('legacyImport.pausedDescription')}
              </DialogDescription>
            </DialogHeader>
            <ImportMotionScope active={active}>
              <div className="flex h-full min-h-0 flex-col px-6">
                {content}
                <div className="shrink-0 py-4">{footer}</div>
              </div>
            </ImportMotionScope>
          </DialogContent>
        </Dialog>
      )}
      <AlertDialog open={confirmStop && active} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('legacyImport.stopTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('legacyImport.stopDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmStop(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              className={primaryClass}
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (!report) return
                  const generation = epoch.current
                  const next = legacyImportReportSchema.parse(
                    await transport.invoke(Commands.CancelLegacyImport, {
                      runId: report.runId,
                    })
                  )
                  if (generation !== epoch.current) return
                  receiveReport(next)
                  setConfirmStop(false)
                })
              }
            >
              {t('legacyImport.stop')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
