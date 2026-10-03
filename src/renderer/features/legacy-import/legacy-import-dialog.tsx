import { MiddleEllipsis } from '@renderer/components/desktop-kit/middle-ellipsis'
import { VirtualList } from '@renderer/components/desktop-kit/virtual-list/virtual-list'
import { DownloadLibraryIcon, WarningIcon } from '@renderer/components/icons'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Progress } from '@renderer/components/ui/progress'
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
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  open: boolean
  invitation?: boolean
  onClose: () => void
}
type Stage = 'discovery' | 'selection' | 'progress' | 'result'

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
}: Props) {
  const { t } = useTranslation()
  const allSelectionId = useId()
  const [stage, setStage] = useState<Stage>(
    invitation ? 'discovery' : 'selection'
  )
  const [preview, setPreview] = useState<LegacyImportPreview | null>(null)
  const [sources, setSources] = useState<LegacyImportSource[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [report, setReport] = useState<LegacyImportReport | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [confirmStop, setConfirmStop] = useState(false)
  const epoch = useRef(0)
  const actionable = preview?.items.filter((item) => item.selectable) ?? []
  const skipped = preview?.items.filter((item) => !item.selectable) ?? []
  const visible = actionable.filter((item) =>
    item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  )
  const runId = report?.runId
  const finished =
    report && ['completed', 'cancelled', 'failed'].includes(report.stage)
  const resultTitleKey =
    report?.stage === 'cancelled'
      ? 'legacyImport.resultStoppedTitle'
      : report?.stage === 'failed' ||
          report?.items.some(
            (item) =>
              item.outcome === 'failed' || item.outcome === 'unprocessed'
          )
        ? 'legacyImport.resultIncompleteTitle'
        : 'legacyImport.resultTitle'

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

  const scan = useCallback(
    async (source: LegacyImportSource, preserve = false) => {
      const generation = epoch.current
      const next = legacyImportPreviewSchema.parse(
        await transport.invoke(Queries.ScanLegacyImport, {
          sourceHandle: source.sourceHandle,
        })
      )
      if (generation !== epoch.current) return
      setPreview(next)
      setSelected(
        (current) =>
          new Set(
            next.items
              .filter(
                (item) =>
                  item.selectable && (!preserve || current.has(item.itemId))
              )
              .map((item) => item.itemId)
          )
      )
      setQuery('')
      setError(null)
    },
    []
  )

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

  useEffect(() => {
    if (!open) return
    const generation = ++epoch.current
    setStage(invitation ? 'discovery' : 'selection')
    setPreview(null)
    setSources([])
    setReport(null)
    setSelected(new Set())
    void perform(async () => {
      const result = await transport.invoke(Queries.DiscoverLegacyImport)
      if (generation !== epoch.current) return
      const found = (result as unknown[]).map((source) =>
        legacyImportSourceSchema.parse(source)
      )
      setSources(found)
      if (found[0]) await scan(found[0])
    })
    return () => {
      epoch.current++
      busyRef.current = false
    }
  }, [open, invitation, perform, scan])

  useEffect(() => {
    if (!open || !runId || finished) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      try {
        const next = legacyImportReportSchema.parse(
          await transport.invoke(Queries.GetLegacyImportRun, {
            runId,
          })
        )
        if (disposed) return
        setReport(next)
        if (['completed', 'cancelled', 'failed'].includes(next.stage)) {
          setStage('result')
          return
        }
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
  }, [open, runId, finished, failure])

  const pickSource = () =>
    void perform(async () => {
      const result = await transport.invoke(Commands.PickLegacyImportSource)
      if (!result) return
      const source = legacyImportSourceSchema.parse(result)
      setSources((current) =>
        current.some((entry) => entry.sourceHandle === source.sourceHandle)
          ? current
          : [...current, source]
      )
      await scan(source)
    })
  const chooseTorrent = (item: LegacyImportItem) =>
    void perform(async () => {
      if (!preview) return
      const generation = epoch.current
      const result = await transport.invoke(
        Commands.PickLegacyTorrentMetadata,
        {
          previewId: preview.previewId,
          itemId: item.itemId,
        }
      )
      if (!result || generation !== epoch.current) return
      const next = legacyImportPreviewSchema.parse(result)
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
      setQuery('')
    })
  const leave = () =>
    void perform(async () => {
      if (invitation)
        await transport.invoke(Commands.DismissLegacyImportInvitation)
      onClose()
    })
  const viewTasks = () =>
    void perform(async () => {
      if (invitation)
        await transport.invoke(Commands.FinishLegacyImportInvitation)
      else await transport.invoke(Commands.FinishLegacyImportInvitation)
      onClose()
    })
  const startImport = () =>
    void perform(async () => {
      if (!preview || selected.size === 0) return
      setStage('progress')
      try {
        const next = legacyImportReportSchema.parse(
          await transport.invoke(Commands.CommitLegacyImport, {
            previewId: preview.previewId,
            itemIds: [...selected],
          })
        )
        setReport(next)
        if (['completed', 'cancelled', 'failed'].includes(next.stage))
          setStage('result')
      } catch (cause) {
        setStage('selection')
        throw cause
      }
    })
  const retry = () =>
    void perform(async () => {
      if (!report) return
      const next = legacyImportReportSchema.parse(
        await transport.invoke(Commands.RetryLegacyImport, {
          runId: report.runId,
        })
      )
      setReport(next)
      setStage(
        ['completed', 'cancelled', 'failed'].includes(next.stage)
          ? 'result'
          : 'progress'
      )
    })
  const row = (item: LegacyImportItem) => (
    <div
      className="flex h-12 items-center gap-3 border-b border-border/60 px-1"
      key={item.itemId}
    >
      <Checkbox
        aria-label={item.name}
        disabled={busy}
        checked={selected.has(item.itemId)}
        onCheckedChange={(checked) =>
          setSelected((current) => {
            const next = new Set(current)
            if (checked) next.add(item.itemId)
            else next.delete(item.itemId)
            return next
          })
        }
      />
      <MiddleEllipsis
        text={item.name}
        className="min-w-0 flex-1 font-sans! text-xs"
      />
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {t(`legacyImport.reasons.${item.reason}`)}
      </span>
    </div>
  )
  const skippedDetails = skipped.length > 0 && (
    <details className="py-4 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        {t('legacyImport.skipped', { count: skipped.length })}
      </summary>
      <div className="max-h-44 overflow-auto pt-2">
        {skipped.map((item) => (
          <div
            className="flex items-center justify-between gap-3 py-2"
            key={item.itemId}
          >
            <MiddleEllipsis
              text={item.name}
              className="min-w-0 flex-1 font-sans!"
            />
            <span className="shrink-0 text-muted-foreground">
              {t(`legacyImport.reasons.${item.reason}`)}
            </span>
            {item.type === 'bt' && item.reason === 'metadata-required' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || preview?.running}
                onClick={() => chooseTorrent(item)}
              >
                {t('legacyImport.chooseTorrent')}
              </Button>
            )}
          </div>
        ))}
      </div>
    </details>
  )

  return (
    <>
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
          className={`flex max-h-[85vh] flex-col gap-0 p-0 ${stage === 'selection' ? 'h-[min(660px,85vh)] sm:max-w-[780px]' : stage === 'discovery' ? 'sm:max-w-[480px]' : 'sm:max-w-[520px]'}`}
          initialFocus={false}
        >
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
            <DialogTitle className="text-xl">
              {stage === 'result' ? t(resultTitleKey) : t('legacyImport.title')}
            </DialogTitle>
            <DialogDescription>
              {t('legacyImport.pausedDescription')}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <div className="flex shrink-0 items-start justify-between gap-3 px-6 pb-3">
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
              {stage === 'selection' && preview && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void perform(() =>
                      scan(
                        {
                          sourceHandle: preview.sourceHandle,
                          name: preview.sourceName,
                        },
                        true
                      )
                    )
                  }
                >
                  {t('legacyImport.recheck')}
                </Button>
              )}
            </div>
          )}
          {stage === 'discovery' && (
            <div className="min-h-0 overflow-auto px-6 pb-6 text-center">
              <DownloadLibraryIcon
                className="mx-auto my-6 size-12 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="text-sm">
                {busy
                  ? t('legacyImport.loading')
                  : t('legacyImport.discovery', {
                      count: preview?.items.length ?? 0,
                    })}
              </p>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                {t('legacyImport.preserveFiles')}
              </p>
            </div>
          )}
          {stage === 'selection' && (
            <>
              <div className="shrink-0 space-y-3 px-6 pb-3">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate">
                    {t('legacyImport.source')}:{' '}
                    {preview?.sourceName ?? t('legacyImport.noSource')}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={pickSource}
                  >
                    {t('legacyImport.changeSource')}
                  </Button>
                </div>
                {sources.length > 1 && (
                  <div className="flex flex-wrap gap-2">
                    {sources.map((source) => (
                      <Button
                        key={source.sourceHandle}
                        variant="outline"
                        size="sm"
                        disabled={
                          busy || preview?.sourceHandle === source.sourceHandle
                        }
                        onClick={() => void perform(() => scan(source))}
                      >
                        {source.name}
                      </Button>
                    ))}
                  </div>
                )}
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('legacyImport.continueBefore')}{' '}
                  {t('legacyImport.capabilityLimit')}
                </p>
                {preview?.running && (
                  <div
                    role="alert"
                    className="flex items-start justify-between gap-3 rounded-md border p-3 text-xs"
                  >
                    <span>
                      <WarningIcon
                        className="me-2 inline size-4"
                        aria-hidden="true"
                      />
                      {t('legacyImport.running')}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform(() =>
                          scan(
                            {
                              sourceHandle: preview.sourceHandle,
                              name: preview.sourceName,
                            },
                            true
                          )
                        )
                      }
                    >
                      {t('legacyImport.recheck')}
                    </Button>
                  </div>
                )}
                {actionable.length > 20 && (
                  <Input
                    aria-label={t('legacyImport.search')}
                    placeholder={t('legacyImport.search')}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                )}
                {actionable.length > 0 && (
                  <label
                    htmlFor={allSelectionId}
                    className="flex items-center gap-3 text-xs"
                  >
                    <Checkbox
                      id={allSelectionId}
                      disabled={busy}
                      checked={selected.size === actionable.length}
                      indeterminate={
                        selected.size > 0 && selected.size < actionable.length
                      }
                      onCheckedChange={(checked) =>
                        setSelected(
                          new Set(
                            checked ? actionable.map((item) => item.itemId) : []
                          )
                        )
                      }
                    />
                    {t('legacyImport.selectAll')}
                  </label>
                )}
              </div>
              {actionable.length > 100 ? (
                <VirtualList
                  items={visible}
                  getId={(item) => item.itemId}
                  rowHeight={48}
                  className="min-h-0 flex-1 px-6"
                  renderRow={({ item }) => row(item)}
                />
              ) : (
                <div className="min-h-0 flex-1 overflow-auto px-6">
                  {busy && !preview ? (
                    <p className="py-6 text-xs text-muted-foreground">
                      {t('legacyImport.loading')}
                    </p>
                  ) : visible.length ? (
                    visible.map(row)
                  ) : (
                    <p className="py-6 text-xs text-muted-foreground">
                      {t('legacyImport.empty')}
                    </p>
                  )}
                  {skippedDetails}
                </div>
              )}
              {actionable.length > 100 && skipped.length > 0 && (
                <div className="shrink-0 px-6">{skippedDetails}</div>
              )}
              <p className="shrink-0 px-6 py-4 text-[11px] leading-5 text-muted-foreground">
                {t('legacyImport.backupNote')}
              </p>
            </>
          )}
          {stage === 'progress' && (
            <div className="px-6 py-8">
              <p className="mb-5 text-sm" aria-live="polite">
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
              />
              <p className="mt-3 text-xs text-muted-foreground">
                {t('legacyImport.processed', {
                  done: report?.processed ?? 0,
                  total: report?.total ?? selected.size,
                })}
              </p>
            </div>
          )}
          {stage === 'result' && report && (
            <div className="min-h-0 overflow-auto px-6 pb-6">
              <p className="py-4 text-3xl font-semibold">
                {t('legacyImport.importedCount', { count: report.imported })}
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('legacyImport.resultDescription')}
              </p>
              <details className="mt-5 text-xs">
                <summary className="cursor-pointer">
                  {t('legacyImport.details')}
                </summary>
                <div className="max-h-64 overflow-auto py-3">
                  {report.items.map((item) => (
                    <p
                      className="flex items-start justify-between gap-3 py-2"
                      key={item.itemId}
                    >
                      <MiddleEllipsis
                        text={item.name}
                        className="min-w-0 font-sans!"
                      />
                      <span className="shrink-0 text-muted-foreground">
                        {t(`legacyImport.reasons.${item.reason}`)}
                      </span>
                    </p>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await transport.invoke(
                        Commands.ExportLegacyImportReport,
                        { runId: report.runId }
                      )
                    })
                  }
                >
                  {t('legacyImport.exportReport')}
                </Button>
              </details>
            </div>
          )}
          <DialogFooter className="shrink-0 border-t px-6 py-4">
            {stage === 'discovery' && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={leave}
                >
                  {t('legacyImport.skip')}
                </Button>
                <Button
                  size="sm"
                  disabled={busy || !preview}
                  onClick={() => setStage('selection')}
                >
                  {t('legacyImport.chooseTasks')}
                </Button>
              </>
            )}
            {stage === 'selection' && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={leave}
                >
                  {t(invitation ? 'legacyImport.skip' : 'legacyImport.back')}
                </Button>
                <Button
                  size="sm"
                  disabled={busy || selected.size === 0 || preview?.running}
                  onClick={startImport}
                >
                  {t('legacyImport.importSelected', { count: selected.size })}
                </Button>
              </>
            )}
            {stage === 'progress' && (
              <Button
                size="sm"
                variant="outline"
                disabled={!report || busy}
                onClick={() => setConfirmStop(true)}
              >
                {t('legacyImport.stop')}
              </Button>
            )}
            {stage === 'result' && (
              <>
                {report?.items.some(
                  (item) =>
                    item.outcome === 'failed' || item.outcome === 'unprocessed'
                ) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={retry}
                  >
                    {t('legacyImport.retry')}
                  </Button>
                )}
                <Button size="sm" disabled={busy} onClick={viewTasks}>
                  {t('legacyImport.viewTasks')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
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
              onClick={() => setConfirmStop(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() =>
                void perform(async () => {
                  if (report)
                    setReport(
                      legacyImportReportSchema.parse(
                        await transport.invoke(Commands.CancelLegacyImport, {
                          runId: report.runId,
                        })
                      )
                    )
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
