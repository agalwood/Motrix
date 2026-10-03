import { MiddleEllipsis } from '@renderer/components/desktop-kit/middle-ellipsis'
import { VirtualList } from '@renderer/components/desktop-kit/virtual-list/virtual-list'
import {
  CheckIcon,
  DownloadLibraryIcon,
  FolderIcon,
  HttpIcon,
  MagnetIcon,
  TorrentFileIcon,
  WarningIcon,
} from '@renderer/components/icons'
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
import {
  ImportPageLayout,
  type ImportStage,
  ImportTransferIllustration,
} from './import-page-layout'

interface Props {
  open: boolean
  invitation?: boolean
  onClose: () => void
  onViewTasks?: () => void
  presentation?: 'dialog' | 'page'
  active?: boolean
}
type Stage = ImportStage

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
  const invitationRef = useRef(invitation)
  invitationRef.current = invitation
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
    setStage(invitationRef.current ? 'discovery' : 'selection')
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
  }, [open, perform, scan])

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
      if (invitation) {
        await transport.invoke(Commands.DismissLegacyImportInvitation)
        setStage('selection')
      }
      onClose()
    })
  const viewTasks = () =>
    void perform(async () => {
      await transport.invoke(Commands.FinishLegacyImportInvitation)
      ;(onViewTasks ?? onClose)()
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
  const row = (item: LegacyImportItem) => {
    const Icon =
      item.type === 'bt'
        ? TorrentFileIcon
        : item.type === 'magnet'
          ? MagnetIcon
          : HttpIcon
    return (
      <div
        className={
          page
            ? 'flex h-16 items-center gap-3 border-b border-border/50 px-4 transition-colors hover:bg-muted/35 motion-reduce:transition-none'
            : 'flex h-12 items-center gap-3 border-b border-border/60 px-1'
        }
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
        {page && (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/65 text-muted-foreground">
            <Icon aria-hidden="true" className="size-4" />
          </span>
        )}
        <div
          className={
            page
              ? 'min-w-0 flex-1 space-y-1'
              : 'flex min-w-0 flex-1 items-center gap-3'
          }
        >
          <MiddleEllipsis
            text={item.name}
            className="min-w-0 flex-1 font-sans! text-xs font-medium"
          />
          <p className="shrink-0 text-[11px] text-muted-foreground">
            {t(`legacyImport.reasons.${item.reason}`)}
          </p>
        </div>
      </div>
    )
  }
  const skippedDetails = skipped.length > 0 && (
    <details
      className={
        page
          ? 'border-t border-border/50 bg-muted/20 px-4 py-3 text-xs'
          : 'py-4 text-xs'
      }
    >
      <summary className="cursor-pointer text-muted-foreground">
        {t('legacyImport.skipped', { count: skipped.length })}
      </summary>
      <div className="max-h-44 overflow-auto pt-2">
        {skipped.map((item) => (
          <div
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2"
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

  const footer = (
    <DialogFooter
      className={
        presentation === 'page'
          ? 'w-full shrink-0'
          : 'shrink-0 border-t px-6 py-4'
      }
    >
      {stage === 'discovery' && (
        <>
          <Button size="sm" variant="outline" disabled={busy} onClick={leave}>
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
          <Button size="sm" variant="outline" disabled={busy} onClick={leave}>
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
            <Button size="sm" variant="outline" disabled={busy} onClick={retry}>
              {t('legacyImport.retry')}
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={viewTasks}>
            {t('legacyImport.viewTasks')}
          </Button>
        </>
      )}
    </DialogFooter>
  )
  return (
    <>
      <ImportSurface
        page={page}
        preview={preview}
        selected={selected}
        report={report}
        open={open}
        stage={stage}
        busy={busy}
        onLeave={leave}
        title={t('legacyImport.title')}
        subtitle={stage === 'result' ? t(resultTitleKey) : undefined}
        description={t('legacyImport.pausedDescription')}
        footer={footer}
      >
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
          <div
            className={
              page
                ? 'flex min-h-0 flex-1 flex-col overflow-auto px-6 py-6 text-center'
                : 'min-h-0 overflow-auto px-6 pb-6 text-center'
            }
          >
            <div className={page ? 'my-auto' : undefined}>
              {page ? (
                <ImportTransferIllustration />
              ) : (
                <DownloadLibraryIcon
                  className="mx-auto my-6 size-12 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <p
                className={
                  page ? 'mt-3 text-xl font-semibold tracking-tight' : 'text-sm'
                }
              >
                {busy
                  ? t('legacyImport.loading')
                  : t('legacyImport.discovery', {
                      count: preview?.items.length ?? 0,
                    })}
              </p>
              <p className="mx-auto mt-3 max-w-sm text-xs leading-relaxed text-muted-foreground">
                {t(
                  page
                    ? 'legacyImport.page.discoveryDescription'
                    : 'legacyImport.preserveFiles'
                )}
              </p>
              {page && preview && (
                <p className="mx-auto mt-6 inline-flex max-w-full items-center gap-2 rounded-full bg-muted/70 px-3 py-1.5 text-[11px] text-muted-foreground">
                  <FolderIcon
                    aria-hidden="true"
                    className="size-3.5 shrink-0"
                  />
                  <span className="truncate">{preview.sourceName}</span>
                </p>
              )}
            </div>
          </div>
        )}
        {stage === 'selection' && (
          <>
            <div
              className={
                page
                  ? 'shrink-0 space-y-3 border-b border-border/70 bg-muted/15 px-4 py-4'
                  : 'shrink-0 space-y-3 px-6 pb-3'
              }
            >
              <div className="flex items-center justify-between gap-3 text-xs">
                <div className="flex min-w-0 items-center gap-3">
                  {page && (
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background">
                      <FolderIcon
                        aria-hidden="true"
                        className="size-4 text-muted-foreground"
                      />
                    </span>
                  )}
                  <div className="min-w-0">
                    {page && (
                      <p className="mb-1 text-[10px] font-medium text-muted-foreground">
                        {t('legacyImport.page.sourceLabel')}
                      </p>
                    )}
                    <p
                      className="truncate font-medium"
                      title={preview?.sourceName}
                    >
                      {!page && `${t('legacyImport.source')}: `}
                      {preview?.sourceName ?? t('legacyImport.noSource')}
                    </p>
                  </div>
                </div>
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
                rowHeight={page ? 64 : 48}
                className={page ? 'min-h-0 flex-1' : 'min-h-0 flex-1 px-6'}
                renderRow={({ item }) => row(item)}
              />
            ) : (
              <div
                className={
                  page
                    ? 'min-h-0 flex-1 overflow-auto'
                    : 'min-h-0 flex-1 overflow-auto px-6'
                }
              >
                {busy && !preview ? (
                  <p className="px-4 py-6 text-xs leading-relaxed text-muted-foreground">
                    {t('legacyImport.loading')}
                  </p>
                ) : visible.length ? (
                  visible.map(row)
                ) : (
                  <p className="px-4 py-6 text-xs leading-relaxed text-muted-foreground">
                    {t('legacyImport.empty')}
                  </p>
                )}
                {skippedDetails}
              </div>
            )}
            {actionable.length > 100 && skipped.length > 0 && (
              <div className={page ? 'shrink-0' : 'shrink-0 px-6'}>
                {skippedDetails}
              </div>
            )}
            {!page && (
              <p className="shrink-0 px-6 py-4 text-[11px] leading-5 text-muted-foreground">
                {t('legacyImport.backupNote')}
              </p>
            )}
          </>
        )}
        {stage === 'progress' && (
          <div
            className={
              page
                ? 'flex min-h-0 flex-1 flex-col justify-center overflow-auto px-8 py-8'
                : 'px-6 py-8'
            }
          >
            {page && (
              <DownloadLibraryIcon
                aria-hidden="true"
                className="mx-auto mb-6 size-9 text-muted-foreground"
              />
            )}
            <p
              className={
                page
                  ? 'mb-6 text-center text-lg font-semibold tracking-tight'
                  : 'mb-5 text-sm'
              }
              aria-live="polite"
            >
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
            <p className="mt-3 text-center text-xs tabular-nums text-muted-foreground">
              {t('legacyImport.processed', {
                done: report?.processed ?? 0,
                total: report?.total ?? selected.size,
              })}
            </p>
          </div>
        )}
        {stage === 'result' && report && (
          <div
            className={
              page
                ? 'min-h-0 flex-1 overflow-auto px-6 py-7'
                : 'min-h-0 overflow-auto px-6 pb-6'
            }
          >
            {page && (
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted">
                {resultTitleKey === 'legacyImport.resultTitle' ? (
                  <CheckIcon aria-hidden="true" className="size-6" />
                ) : (
                  <WarningIcon aria-hidden="true" className="size-6" />
                )}
              </div>
            )}
            {page && (
              <h2 className="text-sm font-medium text-muted-foreground">
                {t(resultTitleKey)}
              </h2>
            )}
            <p className="py-4 text-3xl font-semibold tracking-tight">
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
                    await transport.invoke(Commands.ExportLegacyImportReport, {
                      runId: report.runId,
                    })
                  })
                }
              >
                {t('legacyImport.exportReport')}
              </Button>
            </details>
          </div>
        )}
      </ImportSurface>
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

function ImportSurface({
  page,
  preview,
  selected,
  report,
  open,
  stage,
  busy,
  onLeave,
  title,
  subtitle,
  description,
  footer,
  children,
}: {
  page: boolean
  preview: LegacyImportPreview | null
  selected: ReadonlySet<string>
  report: LegacyImportReport | null
  open: boolean
  stage: Stage
  busy: boolean
  onLeave: () => void
  title: string
  subtitle?: string
  description: string
  footer: ReactNode
  children: ReactNode
}) {
  if (page)
    return (
      <ImportPageLayout
        title={title}
        stage={stage}
        preview={preview}
        selected={selected}
        report={report}
        footer={footer}
      >
        {children}
      </ImportPageLayout>
    )
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (!next) {
          if (stage === 'progress' || busy) details.cancel()
          else onLeave()
        }
      }}
    >
      <DialogContent
        className={`flex max-h-[85vh] flex-col gap-0 p-0 ${stage === 'selection' ? 'h-[min(660px,85vh)] sm:max-w-[780px]' : stage === 'discovery' ? 'sm:max-w-[480px]' : 'sm:max-w-[520px]'}`}
        initialFocus={false}
      >
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
          <DialogTitle className="text-xl">{subtitle ?? title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {footer}
      </DialogContent>
    </Dialog>
  )
}
