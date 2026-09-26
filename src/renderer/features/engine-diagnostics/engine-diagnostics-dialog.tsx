import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import {
  ChevronRightIcon,
  CloseIcon,
  DiagnosticReportIcon,
  LoadingIcon,
  ResetIcon,
  StatusCompleteIcon,
  StatusFailedIcon,
} from '@renderer/components/icons'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollBar,
} from '@renderer/components/ui/scroll-area'
import { toast } from '@renderer/components/ui/toast'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { EngineConnectionSchema } from '@shared/schemas/engine-connection'
import {
  type EngineDiagnosticReport,
  EngineProcessOwnership,
  EngineRecoveryAction,
  EngineRecoveryRecommendation,
  type EngineRecoveryResult,
  EngineState,
} from '@shared/types/engine'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  consumeEngineDiagnosticsRequest,
  ENGINE_FAILURE_TOAST_ID,
  subscribeEngineDiagnostics,
} from './controller'
import { formatEngineDiagnostics } from './diagnostic-report'

const key = 'panel.dashboard.engine.diagnostics'

type CheckState = 'pass' | 'warn' | 'fail' | 'neutral'

function CheckRow({
  label,
  value,
  state = 'neutral',
  action,
  testId,
}: {
  label: string
  value: string
  state?: CheckState
  action?: ReactNode
  testId?: string
}) {
  return (
    <div
      data-testid={testId}
      className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1 py-1.5 text-xs leading-5"
    >
      <dt className="whitespace-nowrap text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-start justify-between gap-2">
        <span
          className={cn(
            'min-w-0 break-words',
            state === 'pass' && 'text-muted-foreground',
            state === 'warn' && 'text-amber-600 dark:text-amber-400',
            state === 'fail' && 'text-destructive'
          )}
        >
          {value}
        </span>
        {action}
      </dd>
    </div>
  )
}

function processDescription(
  report: EngineDiagnosticReport,
  t: ReturnType<typeof useTranslation>['t']
): string {
  if (report.rpc.available) return t(`${key}.process.none`)
  if (!report.process) return t(`${key}.process.unidentified`)
  return t(`${key}.process.${report.process.ownership}`, {
    pid: report.process.pid,
    name: report.process.name,
  })
}

function recoveryAction(
  report: EngineDiagnosticReport | null
): EngineRecoveryAction | null {
  if (
    !report ||
    report.state === EngineState.Starting ||
    report.state === EngineState.Restarting
  )
    return null
  if (report.canForceTerminate) return EngineRecoveryAction.ForceTerminate
  if (report.canSwitchPort && report.suggestedRpcPort)
    return EngineRecoveryAction.SwitchPort
  if (report.canRetry || report.state === EngineState.Ready)
    return EngineRecoveryAction.Retry
  return null
}

export function EngineDiagnosticsDialogHost() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(() => consumeEngineDiagnosticsRequest())
  const [report, setReport] = useState<EngineDiagnosticReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [confirmForce, setConfirmForce] = useState(false)
  const [confirmRestoreDefault, setConfirmRestoreDefault] = useState(false)
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const current = ++requestId.current
    setLoading(true)
    setLoadFailed(false)
    try {
      const next = (await transport.invoke(
        Queries.GetEngineDiagnostics
      )) as EngineDiagnosticReport
      if (current === requestId.current) setReport(next)
    } catch {
      if (current === requestId.current) {
        setLoadFailed(true)
        toast.add({ title: t(`${key}.loadFailed`), type: 'error' })
      }
    } finally {
      if (current === requestId.current) setLoading(false)
    }
  }, [t])

  useEffect(() => subscribeEngineDiagnostics(() => setOpen(true)), [])
  useEffect(() => {
    if (open) {
      toast.close(ENGINE_FAILURE_TOAST_ID)
      void load()
    }
    return () => {
      requestId.current++
    }
  }, [load, open])

  const recover = async (action: EngineRecoveryAction) => {
    setRecovering(true)
    try {
      const result = (await transport.invoke(Commands.RecoverEngine, {
        action,
        ...(action === EngineRecoveryAction.ForceTerminate && report?.process
          ? { expectedPid: report.process.pid }
          : action === EngineRecoveryAction.RestoreDefaultPort &&
              report?.defaultRpc.process
            ? { expectedPid: report.defaultRpc.process.pid }
            : {}),
      })) as EngineRecoveryResult
      toast.add({
        title: result.ok
          ? action === EngineRecoveryAction.RestoreDefaultPort
            ? t(`${key}.fallback.restoredDefault`, { port: result.rpcPort })
            : action === EngineRecoveryAction.SwitchPort
              ? t(`${key}.recoveredOnPort`, { port: result.rpcPort })
              : t(`${key}.recovered`)
          : t(`${key}.recoveryFailed`),
        type: result.ok ? 'success' : 'error',
      })
    } catch {
      toast.add({ title: t(`${key}.recoveryFailed`), type: 'error' })
    } finally {
      await load()
      setRecovering(false)
      setConfirmForce(false)
      setConfirmRestoreDefault(false)
    }
  }

  const busy = loading || recovering
  const ready = report?.state === EngineState.Ready
  const connectionResult = EngineConnectionSchema.safeParse(
    report?.rpc.connection
  )
  const rpcConnection = connectionResult.success ? connectionResult.data : null
  const connectionLost = ready && rpcConnection?.connected === false
  const healthy = ready && !connectionLost
  const transitioning =
    report?.state === EngineState.Starting ||
    report?.state === EngineState.Restarting
  const action = recoveryAction(report)
  const reason = report?.failure?.reason ?? 'unknown'
  const summary = connectionLost
    ? 'rpc_unavailable'
    : report?.state === EngineState.Failed
      ? reason
      : (report?.state ?? 'unknown')
  const engineFeatures = report?.featureReport?.features ?? []
  const processState: CheckState =
    report?.rpc.available ||
    report?.process?.ownership === EngineProcessOwnership.CurrentApp
      ? 'pass'
      : report?.process?.safeToTerminate
        ? 'warn'
        : 'fail'
  const connection = connectionLost
    ? 'disconnected'
    : ready
      ? 'connected'
      : transitioning
        ? 'connecting'
        : report?.state === EngineState.Stopped
          ? 'disconnected'
          : 'unavailable'
  const connectionValue = rpcConnection
    ? t(`${key}.runtime.connectionStatus`, {
        transport: t(`${key}.transport.${rpcConnection.transport}`),
        status: t(`${key}.runtime.${connection}`),
      })
    : t(`${key}.runtime.${connection}`)
  const StatusIcon = healthy
    ? StatusCompleteIcon
    : transitioning
      ? LoadingIcon
      : StatusFailedIcon
  const version = report?.binary.version
  const engineName = version?.includes('-motrix.')
    ? t(`${key}.motrixEngine`)
    : report?.binary.name
  const actionLabel =
    action === EngineRecoveryAction.ForceTerminate
      ? t(`${key}.forceRecover`)
      : action === EngineRecoveryAction.SwitchPort
        ? t(`${key}.switchPort`, { port: report?.suggestedRpcPort })
        : t(`${key}.${ready ? 'restart' : 'retry'}`)
  const defaultPortTooltip = !report
    ? ''
    : recovering
      ? t(`${key}.fallback.restoring`, { port: report.defaultRpc.port })
      : report.defaultRpc.available
        ? t(`${key}.fallback.available`, { port: report.defaultRpc.port })
        : report.defaultRpc.requiresTermination
          ? t(`${key}.fallback.verifiedOrphan`, {
              port: report.defaultRpc.port,
              pid: report.defaultRpc.process?.pid ?? '',
            })
          : report.defaultRpc.process
            ? t(`${key}.fallback.blocked`, {
                port: report.defaultRpc.port,
                pid: report.defaultRpc.process.pid,
                name: report.defaultRpc.process.name,
              })
            : t(`${key}.fallback.unidentified`, {
                port: report.defaultRpc.port,
              })
  const restoreDefault =
    report && !report.defaultRpc.isCurrent ? (
      <TooltipProvider delay={300}>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="inline-flex shrink-0"
                tabIndex={
                  busy || loadFailed || !report.defaultRpc.canRestore
                    ? 0
                    : undefined
                }
              >
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label={t(`${key}.fallback.restore`, {
                    port: report.defaultRpc.port,
                  })}
                  disabled={busy || loadFailed || !report.defaultRpc.canRestore}
                  onClick={() =>
                    report.defaultRpc.requiresTermination
                      ? setConfirmRestoreDefault(true)
                      : void recover(EngineRecoveryAction.RestoreDefaultPort)
                  }
                >
                  <ResetIcon aria-hidden="true" />
                </Button>
              </span>
            }
          />
          <TooltipContent side="left" className="max-w-80">
            {defaultPortTooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ) : undefined

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (recovering) return
          if (!next) requestId.current++
          setOpen(next)
        }}
        onOpenChangeComplete={(next) => {
          if (next || open) return
          // Keep the closing content intact until the popup is unmounted.
          setReport(null)
          setDetailsOpen(false)
          setLoadFailed(false)
          setLoading(false)
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-h-[min(85dvh,720px)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-[560px]"
        >
          <DialogHeader className="flex-row items-center justify-between gap-3 px-5 pt-4 pb-3">
            <DialogTitle className="shrink-0 text-sm">
              {t(`${key}.title`)}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t(`${key}.description`)}
            </DialogDescription>
            <div className="flex min-w-0 items-center gap-2">
              {report && (
                <span className="truncate text-xs tabular-nums text-muted-foreground">
                  {t(`${key}.lastChecked`, {
                    time: new Date(report.generatedAt).toLocaleTimeString(),
                  })}
                </span>
              )}
              <DialogClose
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={recovering}
                    aria-label={t('common.close')}
                  />
                }
              >
                <CloseIcon aria-hidden="true" />
              </DialogClose>
            </div>
          </DialogHeader>
          <ScrollArea className="flex min-h-0 flex-col">
            <ScrollAreaViewport
              data-testid="engine-diagnostics-scroll"
              tabIndex={-1}
              className="min-h-0 flex-1 overscroll-contain"
            >
              <ScrollAreaContent className="px-5" style={{ minWidth: '100%' }}>
                {loadFailed && (
                  <p
                    role="alert"
                    className="pb-4 text-xs leading-5 text-destructive"
                  >
                    {t(`${key}.${report ? 'refreshFailed' : 'loadFailed'}`)}
                  </p>
                )}
                {!report && !loadFailed && (
                  <div
                    role="status"
                    className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
                  >
                    <LoadingIcon
                      aria-hidden="true"
                      className="size-4 animate-spin"
                    />
                    {t(`${key}.checking`)}
                  </div>
                )}
                {report && (
                  <>
                    <div
                      className="flex items-start gap-3 pt-1 pb-4"
                      aria-live="polite"
                    >
                      <StatusIcon
                        aria-hidden="true"
                        className={cn(
                          'mt-0.5 size-5 shrink-0',
                          healthy
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : report.state === EngineState.Failed ||
                                connectionLost
                              ? 'text-destructive'
                              : 'text-muted-foreground',
                          transitioning && 'animate-spin'
                        )}
                      />
                      <div className="min-w-0 space-y-1">
                        <h2 className="text-sm font-medium leading-5">
                          {t(`${key}.summary.${summary}`)}
                        </h2>
                        <p className="text-xs leading-5 text-muted-foreground">
                          {healthy
                            ? t(`${key}.communication.ready`)
                            : t(
                                `${key}.impact.${transitioning ? 'connecting' : report.state === EngineState.Stopped ? 'stopped' : 'failed'}`
                              )}
                        </p>
                      </div>
                    </div>
                    <dl className="rounded-md bg-muted/50 px-3 py-1.5">
                      <CheckRow
                        label={t(`${key}.runtime.process`)}
                        value={
                          report.managedPid !== null
                            ? t(`${key}.runtime.running`, {
                                pid: report.managedPid,
                              })
                            : t(`${key}.runtime.notRunning`)
                        }
                      />
                      <CheckRow
                        label={t(`${key}.runtime.connection`)}
                        value={connectionValue}
                        state={
                          report.state === EngineState.Failed || connectionLost
                            ? 'fail'
                            : 'neutral'
                        }
                      />
                      {((!report.rpc.available &&
                        !report.rpc.expectedListener) ||
                        !report.defaultRpc.isCurrent) && (
                        <CheckRow
                          testId="engine-check-rpc"
                          label={t('panel.dashboard.engine.rpcPort')}
                          value={t(
                            `${key}.port.${report.rpc.expectedListener ? 'listening' : report.rpc.available ? 'available' : 'occupied'}`,
                            { port: report.rpc.port }
                          )}
                          state={
                            report.rpc.expectedListener || report.rpc.available
                              ? 'neutral'
                              : 'fail'
                          }
                          action={restoreDefault}
                        />
                      )}
                    </dl>
                    {!transitioning &&
                      report.recommendation !==
                        EngineRecoveryRecommendation.None && (
                        <p className="pt-3 text-xs leading-5 text-muted-foreground">
                          {t(`${key}.recommendation.${report.recommendation}`, {
                            port: report.suggestedRpcPort ?? '',
                            rpcPort: report.rpc.port,
                            pid: report.process?.pid ?? '',
                          })}
                        </p>
                      )}
                    <Collapsible
                      open={detailsOpen}
                      onOpenChange={setDetailsOpen}
                      className="mt-3 mb-2"
                    >
                      <CollapsibleTrigger className="group -mx-3 flex min-h-12 w-[calc(100%+1.5rem)] items-center gap-3 rounded-lg px-3 py-2.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <DiagnosticReportIcon
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                          <span className="text-sm">{t(`${key}.details`)}</span>
                          <span
                            className="text-xs text-muted-foreground"
                            data-testid="engine-version-summary"
                          >
                            {engineName} {version ?? t(`${key}.versionUnknown`)}
                          </span>
                        </span>
                        <ChevronRightIcon
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
                        />
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="border-t pb-4 pt-2">
                          <dl className="divide-y divide-border/50">
                            <CheckRow
                              label={t(`${key}.checks.binary`)}
                              value={
                                report.binary.available
                                  ? t(`${key}.binary.available`, {
                                      name: report.binary.name,
                                      version:
                                        version ?? t(`${key}.versionUnknown`),
                                    })
                                  : t(`${key}.binary.unavailable`, {
                                      name: report.binary.name,
                                    })
                              }
                              state={report.binary.available ? 'pass' : 'fail'}
                            />
                            <CheckRow
                              label={t(`${key}.checks.features`)}
                              value={
                                engineFeatures.length
                                  ? engineFeatures.join(', ')
                                  : t(
                                      `${key}.features.${report.binary.available ? 'none' : 'unavailable'}`
                                    )
                              }
                              state={
                                !report.binary.available
                                  ? 'neutral'
                                  : engineFeatures.length
                                    ? 'pass'
                                    : 'warn'
                              }
                            />
                            <CheckRow
                              label={t(`${key}.checks.rpc`)}
                              value={t(
                                `${key}.rpc.${report.rpc.expectedListener ? 'listening' : report.rpc.available ? 'available' : 'occupied'}`,
                                { port: report.rpc.port }
                              )}
                              state={
                                report.rpc.available ||
                                report.rpc.expectedListener
                                  ? 'pass'
                                  : 'fail'
                              }
                            />
                            <CheckRow
                              label={t(`${key}.checks.process`)}
                              value={processDescription(report, t)}
                              state={processState}
                            />
                            <CheckRow
                              label={t(`${key}.checks.communication`)}
                              value={connectionValue}
                              state={
                                healthy
                                  ? 'pass'
                                  : report.state === EngineState.Failed ||
                                      connectionLost
                                    ? 'fail'
                                    : 'neutral'
                              }
                            />
                          </dl>
                          {report.failure?.technicalMessage && (
                            <div className="mt-3 space-y-1.5">
                              <p className="text-xs text-muted-foreground">
                                {t(`${key}.technicalDetails`)}
                              </p>
                              <pre className="max-w-full whitespace-pre-wrap break-all rounded-md bg-muted/60 p-2.5 font-mono text-xs leading-5">
                                {report.failure.technicalMessage}
                              </pre>
                            </div>
                          )}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </>
                )}
              </ScrollAreaContent>
            </ScrollAreaViewport>
            <ScrollBar />
          </ScrollArea>
          <DialogFooter className="flex-row flex-wrap items-center justify-between gap-2 border-t px-5 py-3 sm:justify-between">
            <CopyButton
              key={report?.generatedAt ?? 'empty'}
              variant="ghost"
              size="sm"
              className="-ms-2 text-xs text-muted-foreground"
              disabled={!report || busy}
              content={report ? formatEngineDiagnostics(report) : ''}
              copiedLabel={t(`${key}.copied`)}
              onCopyError={() =>
                toast.add({ title: t(`${key}.copyFailed`), type: 'error' })
              }
            >
              {t(`${key}.copy`)}
            </CopyButton>
            <div className="ms-auto flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={busy}
                onClick={load}
              >
                {loading && (
                  <LoadingIcon aria-hidden="true" className="animate-spin" />
                )}
                {t(`${key}.runAgain`)}
              </Button>
              {action && (
                <Button
                  size="sm"
                  className="text-xs"
                  variant={
                    action === EngineRecoveryAction.ForceTerminate
                      ? 'destructive'
                      : ready
                        ? 'outline'
                        : 'default'
                  }
                  disabled={busy || loadFailed}
                  onClick={() =>
                    action === EngineRecoveryAction.ForceTerminate
                      ? setConfirmForce(true)
                      : void recover(action)
                  }
                >
                  {recovering && (
                    <LoadingIcon aria-hidden="true" className="animate-spin" />
                  )}
                  {actionLabel}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmForce} onOpenChange={setConfirmForce}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('panel.dashboard.engine.diagnostics.confirmForce.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'panel.dashboard.engine.diagnostics.confirmForce.description',
                {
                  pid: report?.process?.pid ?? '',
                }
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className={cn(buttonVariants({ variant: 'destructive' }))}
              onClick={() => recover(EngineRecoveryAction.ForceTerminate)}
            >
              {t('panel.dashboard.engine.diagnostics.confirmForce.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmRestoreDefault}
        onOpenChange={setConfirmRestoreDefault}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('panel.dashboard.engine.diagnostics.fallback.confirm.title', {
                port: report?.defaultRpc.port ?? '',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'panel.dashboard.engine.diagnostics.fallback.confirm.description',
                {
                  port: report?.defaultRpc.port ?? '',
                  pid: report?.defaultRpc.process?.pid ?? '',
                }
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => recover(EngineRecoveryAction.RestoreDefaultPort)}
            >
              {t('panel.dashboard.engine.diagnostics.fallback.confirm.action', {
                port: report?.defaultRpc.port ?? '',
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
