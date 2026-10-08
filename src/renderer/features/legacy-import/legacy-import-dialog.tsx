import { MiddleEllipsis } from '@renderer/components/desktop-kit/middle-ellipsis'
import {
  CheckIcon,
  RevealFolderIcon,
  WarningIcon,
} from '@renderer/components/icons'
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
import { Label } from '@renderer/components/ui/label'
import { Progress } from '@renderer/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@renderer/components/ui/radio-group'
import { Spinner } from '@renderer/components/ui/spinner'
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
  legacyImportSourceSelectionSchema,
} from '@shared/schemas/legacy-import'
import {
  Component,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { ImportIllustration } from './import-illustration'
import { ImportMotionScope, ImportResultMark } from './import-motion'
import {
  ImportPageLayout,
  type ImportStage,
  ImportStageHeading,
} from './import-page-layout'
import { ImportResultDetails } from './import-result-details'
import { ImportSourceFeedback } from './import-source-feedback'
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
type SourceAction =
  | { type: 'discover' }
  | { type: 'pick'; dataPath?: string }
  | { type: 'scan' | 'reveal'; sourceHandle: string }
interface ImportFailure {
  key: string
  sourceAction?: SourceAction
}
const sourceNeedsSelection = (key: string) =>
  [
    'invalidSource',
    'unsafeSource',
    'sourceNotAuthorized',
    'changedSource',
    'rescanRequired',
  ].some((code) => key === `legacyImport.errors.${code}`)
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
  const sourceGroupId = useId()
  const [stage, setStage] = useState<ImportStage>('discovery')
  const [preview, setPreview] = useState<LegacyImportPreview | null>(null)
  const previewRef = useRef<LegacyImportPreview | null>(null)
  const [sources, setSources] = useState<LegacyImportSource[]>([])
  const [rejectedPaths, setRejectedPaths] = useState<string[]>([])
  const [sourceHandle, setSourceHandle] = useState<string | null>(null)
  const sourceHandleRef = useRef<string | null>(null)
  const sourceFeedbackEpoch = useRef(0)
  const [sourceActivity, setSourceActivity] = useState<
    'discover' | 'scan' | null
  >(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<LegacyImportItem['type']>>(
    new Set()
  )
  const [report, setReport] = useState<LegacyImportReport | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<ImportFailure | null>(null)
  const [unavailableSource, setUnavailableSource] =
    useState<ImportFailure | null>(null)
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
    (cause: unknown, sourceAction?: SourceAction) => {
      const message = cause instanceof Error ? cause.message : String(cause)
      const found = message.match(/legacyImport\.(?:errors\.)?[a-zA-Z]+/)?.[0]
      const key = found?.includes('.errors.')
        ? found
        : found
          ? `legacyImport.errors.${found.split('.').at(-1)}`
          : undefined
      const next = {
        key: key && t(key) !== key ? key : 'legacyImport.errors.failed',
        sourceAction,
      }
      if (sourceAction?.type === 'scan' && sourceNeedsSelection(next.key)) {
        setUnavailableSource(next)
        const source = sources.find(
          (entry) => entry.sourceHandle === sourceAction.sourceHandle
        )
        if (source)
          setRejectedPaths((current) =>
            current.includes(source.dataPath)
              ? current
              : [...current, source.dataPath]
          )
      }
      setError(next)
    },
    [t, sources]
  )
  const failureRef = useRef(failure)
  useEffect(() => {
    failureRef.current = failure
  }, [failure])

  const perform = useCallback(
    async (
      operation: () => Promise<void>,
      options?: { sourceAction?: SourceAction; preserveError?: boolean }
    ) => {
      if (busyRef.current) return
      ++sourceFeedbackEpoch.current
      const generation = epoch.current
      busyRef.current = true
      setBusy(true)
      const action = options?.sourceAction?.type
      setSourceActivity(
        action === 'discover' || action === 'scan' ? action : null
      )
      if (!options?.preserveError) setError(null)
      try {
        await operation()
      } catch (cause) {
        if (generation === epoch.current)
          failureRef.current(cause, options?.sourceAction)
      } finally {
        if (generation === epoch.current) {
          busyRef.current = false
          setBusy(false)
          setSourceActivity(null)
        }
      }
    },
    []
  )

  const selectSource = useCallback(
    (source: LegacyImportSource, refresh = false) => {
      if (source.sourceHandle === sourceHandleRef.current && !refresh) return
      ++sourceFeedbackEpoch.current
      sourceHandleRef.current = source.sourceHandle
      setSourceHandle(source.sourceHandle)
      previewRef.current = null
      setPreview(null)
      setSelected(new Set())
      setExpanded(new Set())
      setQuery('')
      setError(null)
      setUnavailableSource(null)
    },
    []
  )

  const scan = useCallback(
    async (source: LegacyImportSource, refresh = false) => {
      const generation = epoch.current
      const sameSource = source.sourceHandle === sourceHandleRef.current
      const preserveSelection = sameSource && previewRef.current !== null
      if (sameSource && previewRef.current && !refresh) return
      selectSource(source)
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
    [selectSource]
  )

  const discover = useCallback(async () => {
    const generation = epoch.current
    const result = await transport.invoke(Queries.DiscoverLegacyImport)
    if (generation !== epoch.current) return
    const found = (result as unknown[]).map((source) =>
      legacyImportSourceSchema.parse(source)
    )
    setSources(found)
    if (found[0]) selectSource(found[0])
  }, [selectSource])

  useEffect(() => {
    if (!open) return
    ++epoch.current
    setStage('discovery')
    previewRef.current = null
    sourceHandleRef.current = null
    setPreview(null)
    setSourceHandle(null)
    setSources([])
    setRejectedPaths([])
    setUnavailableSource(null)
    setReport(null)
    setSelected(new Set())
    setExpanded(new Set())
    setQuery('')
    setConfirmStop(false)
    void perform(discover, { sourceAction: { type: 'discover' } })
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
    void perform(
      async () => {
        const generation = epoch.current
        const result = await transport.invoke(Commands.PickLegacyImportSource)
        if (!result || generation !== epoch.current) return
        const source = legacyImportSourceSelectionSchema.parse(result)
        if ('errorCode' in source) {
          setRejectedPaths((current) =>
            current.includes(source.dataPath)
              ? current
              : [...current, source.dataPath]
          )
          const existing = sources.find(
            (entry) => entry.dataPath === source.dataPath
          )
          failureRef.current(
            new Error(`legacyImport.errors.${source.errorCode}`),
            existing
              ? { type: 'scan', sourceHandle: existing.sourceHandle }
              : { type: 'pick', dataPath: source.dataPath }
          )
          return
        }
        setRejectedPaths((current) =>
          current.filter((entry) => entry !== source.dataPath)
        )
        setSources((current) => [
          ...current.filter(
            (entry) =>
              entry.dataPath !== source.dataPath &&
              entry.sourceHandle !== source.sourceHandle
          ),
          source,
        ])
        selectSource(source, true)
      },
      { sourceAction: { type: 'pick' }, preserveError: true }
    )
  const continueToSelection = () =>
    void perform(
      async () => {
        const source = sources.find(
          (entry) => entry.sourceHandle === sourceHandleRef.current
        )
        if (!source) return
        const generation = epoch.current
        await scan(source)
        if (
          generation === epoch.current &&
          previewRef.current?.sourceHandle === source.sourceHandle
        )
          setStage('selection')
      },
      {
        sourceAction: sourceHandle ? { type: 'scan', sourceHandle } : undefined,
      }
    )
  const revealSource = async (handle: string) => {
    const generation = epoch.current
    const feedbackGeneration = ++sourceFeedbackEpoch.current
    try {
      await transport.invoke(Commands.RevealLegacyImportSource, {
        sourceHandle: handle,
      })
      if (
        generation === epoch.current &&
        feedbackGeneration === sourceFeedbackEpoch.current
      )
        setError((current) =>
          current?.sourceAction?.type === 'reveal' &&
          current.sourceAction.sourceHandle === handle
            ? null
            : current
        )
    } catch (cause) {
      if (
        generation === epoch.current &&
        feedbackGeneration === sourceFeedbackEpoch.current
      )
        failureRef.current(cause, { type: 'reveal', sourceHandle: handle })
    }
  }
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
  const primaryClass = 'migration-primary'
  const sourceError =
    stage === 'discovery'
      ? error?.sourceAction
        ? error
        : !error
          ? unavailableSource
          : null
      : null
  const scanFailed = sourceError?.sourceAction?.type === 'scan'
  const chooseSourceInstead =
    unavailableSource?.sourceAction?.type === 'scan' &&
    unavailableSource.sourceAction.sourceHandle === sourceHandle
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
              disabled={busy || !sourceHandle}
              onClick={chooseSourceInstead ? pickSource : continueToSelection}
            >
              {t(
                chooseSourceInstead
                  ? 'legacyImport.chooseDestination'
                  : scanFailed
                    ? 'legacyImport.page.sourceFeedback.retry'
                    : 'legacyImport.page.continue'
              )}
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
                {t('legacyImport.importSelected')}
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
        <p className="min-w-0 flex-1">{t(error.key)}</p>
        {(stage === 'discovery' || stage === 'selection') && (
          <Button variant="outline" size="sm" disabled={busy} onClick={recheck}>
            {t('legacyImport.recheck')}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
  const sourceFeedback = (handle?: string, dataPath?: string) => {
    const action = sourceError?.sourceAction
    if (
      !sourceError ||
      !action ||
      ('sourceHandle' in action ? action.sourceHandle : undefined) !== handle ||
      (action.type === 'pick' ? action.dataPath : undefined) !== dataPath
    )
      return null
    const chooseFolder = sourceNeedsSelection(sourceError.key)
    const kind =
      action.type === 'scan'
        ? chooseFolder
          ? 'unreadable'
          : 'read'
        : action.type
    const retryAction =
      action.type === 'discover'
        ? () => void perform(discover, { sourceAction: action })
        : action.type === 'reveal'
          ? () => void revealSource(action.sourceHandle)
          : undefined
    return (
      <ImportSourceFeedback
        id={`${sourceGroupId}-error`}
        title={t(`legacyImport.page.sourceFeedback.${kind}Title`)}
        description={
          chooseFolder
            ? t('legacyImport.page.sourceFeedback.chooseFolder')
            : sourceError.key === 'legacyImport.errors.failed'
              ? t(`legacyImport.page.sourceFeedback.${kind}Description`)
              : t(sourceError.key)
        }
        busy={busy}
        onRetry={retryAction}
      />
    )
  }
  const content = (
    <>
      {stage === 'discovery' && (
        <>
          <ImportStageHeading
            title={t('legacyImport.page.welcomeTitle')}
            description={t('legacyImport.page.sourceIntroduction')}
            illustration={<ImportIllustration />}
          />
          {!sourceError && errorNotice}
          <div className="migration-source-options mx-auto min-h-0 w-full max-w-160 flex-1 overflow-auto pt-8 pb-4">
            <h3 id={sourceGroupId} className="mb-5 text-sm font-medium">
              {t('legacyImport.page.sourceTitle')}
            </h3>
            {(sources.length > 0 || rejectedPaths.length > 0) && (
              <RadioGroup
                value={sourceHandle}
                disabled={busy}
                onValueChange={(value) => {
                  const source = sources.find(
                    (entry) => entry.sourceHandle === value
                  )
                  if (source) selectSource(source)
                }}
                aria-labelledby={sourceGroupId}
                className="gap-4"
              >
                {sources.map((source) => (
                  <div key={source.sourceHandle} className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Label
                        className="group flex min-w-0 items-center gap-3 py-2 font-normal leading-normal data-[disabled=true]:opacity-50"
                        data-disabled={
                          busy || rejectedPaths.includes(source.dataPath)
                        }
                      >
                        <RadioGroupItem
                          value={source.sourceHandle}
                          disabled={rejectedPaths.includes(source.dataPath)}
                          aria-labelledby={`${sourceGroupId}-${source.sourceHandle}-path`}
                          aria-describedby={
                            sourceError?.sourceAction &&
                            'sourceHandle' in sourceError.sourceAction &&
                            sourceError.sourceAction.sourceHandle ===
                              source.sourceHandle
                              ? `${sourceGroupId}-error`
                              : undefined
                          }
                          className="border-foreground/35 text-foreground shadow-none data-checked:border-foreground"
                        />
                        <span
                          id={`${sourceGroupId}-${source.sourceHandle}-path`}
                          className="min-w-0"
                        >
                          <MiddleEllipsis
                            text={source.dataPath}
                            className="font-sans text-sm"
                          />
                        </span>
                      </Label>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={busy}
                        aria-label={t('legacyImport.page.revealSource')}
                        aria-describedby={`${sourceGroupId}-${source.sourceHandle}-path`}
                        title={t('legacyImport.page.revealSource')}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => void revealSource(source.sourceHandle)}
                      >
                        <RevealFolderIcon
                          aria-hidden="true"
                          className="size-3.5"
                        />
                      </Button>
                    </div>
                    {sourceFeedback(source.sourceHandle)}
                  </div>
                ))}
                {rejectedPaths
                  .filter(
                    (dataPath) =>
                      !sources.some((source) => source.dataPath === dataPath)
                  )
                  .map((dataPath, index) => (
                    <div key={dataPath} className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Label className="flex min-w-0 items-center gap-3 py-2 font-normal leading-normal opacity-50">
                          <RadioGroupItem
                            value={`rejected:${dataPath}`}
                            disabled
                            aria-labelledby={`${sourceGroupId}-rejected-${index}-path`}
                            aria-describedby={
                              sourceError?.sourceAction?.type === 'pick' &&
                              sourceError.sourceAction.dataPath === dataPath
                                ? `${sourceGroupId}-error`
                                : undefined
                            }
                            className="border-foreground/35 text-foreground shadow-none"
                          />
                          <span
                            id={`${sourceGroupId}-rejected-${index}-path`}
                            className="min-w-0"
                          >
                            <MiddleEllipsis
                              text={dataPath}
                              className="font-sans text-sm"
                            />
                          </span>
                        </Label>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          disabled
                          aria-label={t('legacyImport.page.revealSource')}
                          className="text-muted-foreground"
                        >
                          <RevealFolderIcon
                            aria-hidden="true"
                            className="size-3.5"
                          />
                        </Button>
                      </div>
                      {sourceFeedback(undefined, dataPath)}
                    </div>
                  ))}
              </RadioGroup>
            )}
            {sourceFeedback()}
            {sourceActivity ? (
              <p
                role="status"
                className="flex items-center gap-2 py-3 text-xs text-muted-foreground"
              >
                <Spinner aria-hidden="true" className="size-3.5" />
                {t(
                  sourceActivity === 'scan'
                    ? 'legacyImport.page.sourceFeedback.reading'
                    : 'legacyImport.loading'
                )}
              </p>
            ) : (
              !sources.length &&
              !sourceError && (
                <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                  {t('legacyImport.page.noSourceDescription')}
                </p>
              )
            )}
            {!chooseSourceInstead && (
              <div className="mt-5 flex">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  disabled={busy}
                  onClick={pickSource}
                  className="h-auto px-0 py-1 text-xs font-normal text-muted-foreground underline-offset-4 hover:text-foreground"
                >
                  {t('legacyImport.chooseDestination')}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
      {stage === 'selection' && (
        <>
          <ImportStageHeading
            title={t('legacyImport.page.selectionTitle')}
            description={t('legacyImport.page.introduction')}
            className="pt-4 pb-5"
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
          <p className="migration-selection-note mx-auto w-full max-w-160 shrink-0 py-3 text-xs leading-relaxed text-muted-foreground">
            {t('legacyImport.page.selectedNote', { count: selected.size })}
          </p>
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
