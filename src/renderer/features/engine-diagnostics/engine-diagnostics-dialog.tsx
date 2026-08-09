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
import { Badge } from '@renderer/components/ui/badge'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
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
import {
  type EngineDiagnosticReport,
  EngineProcessOwnership,
  EngineRecoveryAction,
  type EngineRecoveryResult,
  EngineState,
} from '@shared/types/engine'
import {
  AlertTriangle,
  CheckCircle2,
  CircleX,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  consumeEngineDiagnosticsRequest,
  ENGINE_FAILURE_TOAST_ID,
  subscribeEngineDiagnostics,
} from './controller'

interface CheckRowProps {
  label: string
  value: string
  state: 'pass' | 'warn' | 'fail'
  action?: ReactNode
  testId?: string
}

function CheckRow({ label, value, state, action, testId }: CheckRowProps) {
  const Icon =
    state === 'pass' ? CheckCircle2 : state === 'warn' ? AlertTriangle : CircleX
  return (
    <div
      data-testid={testId}
      className="flex items-start gap-3 rounded-md border border-border/70 px-3 py-2.5"
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          state === 'pass' && 'text-emerald-500',
          state === 'warn' && 'text-amber-500',
          state === 'fail' && 'text-destructive'
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0 text-sm font-medium">{label}</div>
          {action && <div className="-mt-1 shrink-0">{action}</div>}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{value}</div>
      </div>
    </div>
  )
}

function processDescription(
  report: EngineDiagnosticReport,
  t: ReturnType<typeof useTranslation>['t']
): string {
  if (report.rpc.available) {
    return t('panel.dashboard.engine.diagnostics.process.none')
  }
  const processInfo = report.process
  if (!processInfo) {
    return t('panel.dashboard.engine.diagnostics.process.unidentified')
  }
  return t(
    `panel.dashboard.engine.diagnostics.process.${processInfo.ownership}`,
    { pid: processInfo.pid, name: processInfo.name }
  )
}

export function EngineDiagnosticsDialogHost() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(() => consumeEngineDiagnosticsRequest())
  const [report, setReport] = useState<EngineDiagnosticReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [confirmForce, setConfirmForce] = useState(false)
  const [confirmRestoreDefault, setConfirmRestoreDefault] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = (await transport.invoke(
        Queries.GetEngineDiagnostics
      )) as EngineDiagnosticReport
      setReport(next)
    } catch {
      toast.add({
        title: t('panel.dashboard.engine.diagnostics.loadFailed'),
        type: 'error',
      })
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => subscribeEngineDiagnostics(() => setOpen(true)), [])

  useEffect(() => {
    if (open) {
      toast.close(ENGINE_FAILURE_TOAST_ID)
      void load()
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
      if (result.ok) {
        toast.add({
          title:
            action === EngineRecoveryAction.RestoreDefaultPort
              ? t(
                  'panel.dashboard.engine.diagnostics.fallback.restoredDefault',
                  { port: result.rpcPort }
                )
              : action === EngineRecoveryAction.SwitchPort
                ? t('panel.dashboard.engine.diagnostics.recoveredOnPort', {
                    port: result.rpcPort,
                  })
                : t('panel.dashboard.engine.diagnostics.recovered'),
          type: 'success',
        })
      } else {
        toast.add({
          title: t('panel.dashboard.engine.diagnostics.recoveryFailed'),
          type: 'error',
        })
      }
      await load()
    } catch {
      toast.add({
        title: t('panel.dashboard.engine.diagnostics.recoveryFailed'),
        type: 'error',
      })
      await load()
    } finally {
      setRecovering(false)
      setConfirmForce(false)
      setConfirmRestoreDefault(false)
    }
  }

  const processState: CheckRowProps['state'] = report?.rpc.available
    ? 'pass'
    : report?.process?.ownership === EngineProcessOwnership.CurrentApp
      ? 'pass'
      : report?.process?.safeToTerminate
        ? 'warn'
        : 'fail'
  const engineFeatures = report?.featureReport?.features ?? []

  const defaultPortTooltip = report
    ? recovering
      ? t('panel.dashboard.engine.diagnostics.fallback.restoring', {
          port: report.defaultRpc.port,
        })
      : report.defaultRpc.available
        ? t('panel.dashboard.engine.diagnostics.fallback.available', {
            port: report.defaultRpc.port,
          })
        : report.defaultRpc.requiresTermination
          ? t('panel.dashboard.engine.diagnostics.fallback.verifiedOrphan', {
              port: report.defaultRpc.port,
              pid: report.defaultRpc.process?.pid ?? '',
            })
          : report.defaultRpc.process
            ? t('panel.dashboard.engine.diagnostics.fallback.blocked', {
                port: report.defaultRpc.port,
                pid: report.defaultRpc.process.pid,
                name: report.defaultRpc.process.name,
              })
            : t('panel.dashboard.engine.diagnostics.fallback.unidentified', {
                port: report.defaultRpc.port,
              })
    : ''

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="h-[min(84vh,760px)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="px-5 pt-5">
            <DialogTitle className="flex items-center gap-2">
              {t('panel.dashboard.engine.diagnostics.title')}
            </DialogTitle>
            <DialogDescription>
              {t('panel.dashboard.engine.diagnostics.description')}
            </DialogDescription>
          </DialogHeader>

          <div
            data-testid="engine-diagnostics-scroll"
            className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-5 pb-1 scrollbar-gutter-stable"
          >
            {loading && !report ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                {t('panel.dashboard.engine.diagnostics.checking')}
              </div>
            ) : report ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">
                      {t('panel.dashboard.engine.diagnostics.currentStatus')}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t('panel.dashboard.engine.diagnostics.lastChecked', {
                        time: new Date(report.generatedAt).toLocaleTimeString(),
                      })}
                    </div>
                  </div>
                  <Badge
                    variant={
                      report.state === EngineState.Ready
                        ? 'secondary'
                        : 'destructive'
                    }
                  >
                    {t(
                      `panel.dashboard.engine.state.${
                        report.state === EngineState.Restarting
                          ? 'reconnecting'
                          : report.state
                      }`
                    )}
                  </Badge>
                </div>

                {report.recommendation !== 'none' && (
                  <div className="flex gap-3 rounded-md bg-muted/60 p-3">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                    <div>
                      <div className="text-sm font-medium">
                        {t(
                          'panel.dashboard.engine.diagnostics.recommendation.title'
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {t(
                          `panel.dashboard.engine.diagnostics.recommendation.${report.recommendation}`,
                          {
                            port: report.suggestedRpcPort ?? '',
                            rpcPort: report.rpc.port,
                            pid: report.process?.pid ?? '',
                          }
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid gap-2">
                  <CheckRow
                    label={t(
                      'panel.dashboard.engine.diagnostics.checks.binary'
                    )}
                    value={
                      report.binary.available
                        ? t(
                            'panel.dashboard.engine.diagnostics.binary.available',
                            {
                              name: report.binary.name,
                              version: report.binary.version ?? '?',
                            }
                          )
                        : t(
                            'panel.dashboard.engine.diagnostics.binary.unavailable',
                            { name: report.binary.name }
                          )
                    }
                    state={report.binary.available ? 'pass' : 'fail'}
                  />
                  <CheckRow
                    label={t(
                      'panel.dashboard.engine.diagnostics.checks.features'
                    )}
                    value={
                      engineFeatures.length > 0
                        ? engineFeatures.join(', ')
                        : report.binary.available
                          ? t(
                              'panel.dashboard.engine.diagnostics.features.none'
                            )
                          : t(
                              'panel.dashboard.engine.diagnostics.features.unavailable'
                            )
                    }
                    state={
                      !report.binary.available
                        ? 'fail'
                        : engineFeatures.length > 0
                          ? 'pass'
                          : 'warn'
                    }
                  />
                  <CheckRow
                    testId="engine-check-rpc"
                    label={t('panel.dashboard.engine.diagnostics.checks.rpc')}
                    value={
                      report.rpc.expectedListener
                        ? t(
                            'panel.dashboard.engine.diagnostics.rpc.listening',
                            { port: report.rpc.port }
                          )
                        : report.rpc.available
                          ? t(
                              'panel.dashboard.engine.diagnostics.rpc.available',
                              { port: report.rpc.port }
                            )
                          : t(
                              'panel.dashboard.engine.diagnostics.rpc.occupied',
                              { port: report.rpc.port }
                            )
                    }
                    state={
                      report.rpc.available || report.rpc.expectedListener
                        ? 'pass'
                        : 'fail'
                    }
                    action={
                      !report.defaultRpc.isCurrent ? (
                        <TooltipProvider delay={300}>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  className="inline-flex"
                                  tabIndex={
                                    recovering || !report.defaultRpc.canRestore
                                      ? 0
                                      : undefined
                                  }
                                >
                                  <Button
                                    variant="outline"
                                    size="icon-xs"
                                    aria-label={t(
                                      'panel.dashboard.engine.diagnostics.fallback.restore',
                                      { port: report.defaultRpc.port }
                                    )}
                                    disabled={
                                      recovering ||
                                      !report.defaultRpc.canRestore
                                    }
                                    onClick={() => {
                                      if (
                                        report.defaultRpc.requiresTermination
                                      ) {
                                        setConfirmRestoreDefault(true)
                                      } else {
                                        void recover(
                                          EngineRecoveryAction.RestoreDefaultPort
                                        )
                                      }
                                    }}
                                  >
                                    {recovering ? (
                                      <LoaderCircle className="animate-spin" />
                                    ) : (
                                      <RotateCcw />
                                    )}
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
                    }
                  />
                  <CheckRow
                    label={t(
                      'panel.dashboard.engine.diagnostics.checks.process'
                    )}
                    value={processDescription(report, t)}
                    state={processState}
                  />
                  <CheckRow
                    label={t(
                      'panel.dashboard.engine.diagnostics.checks.communication'
                    )}
                    value={
                      report.state === EngineState.Ready
                        ? t(
                            'panel.dashboard.engine.diagnostics.communication.ready'
                          )
                        : t(
                            `panel.dashboard.engine.diagnostics.reason.${report.failure?.reason ?? 'unknown'}`
                          )
                    }
                    state={report.state === EngineState.Ready ? 'pass' : 'fail'}
                  />
                </div>

                {report.failure?.technicalMessage && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none">
                      {t('panel.dashboard.engine.diagnostics.technicalDetails')}
                    </summary>
                    <code className="mt-2 block break-all rounded bg-muted p-2">
                      {report.failure.technicalMessage}
                    </code>
                  </details>
                )}
              </>
            ) : null}
          </div>

          <DialogFooter className="border-t px-5 py-4">
            <DialogClose
              render={
                <Button variant="outline" size="sm" disabled={recovering} />
              }
            >
              {t('common.close')}
            </DialogClose>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || recovering}
              onClick={load}
            >
              <RefreshCw className={cn(loading && 'animate-spin')} />
              {t('panel.dashboard.engine.diagnostics.runAgain')}
            </Button>
            {report?.canSwitchPort && report.suggestedRpcPort && (
              <Button
                variant="outline"
                size="sm"
                disabled={recovering}
                onClick={() => recover(EngineRecoveryAction.SwitchPort)}
              >
                {t('panel.dashboard.engine.diagnostics.switchPort', {
                  port: report.suggestedRpcPort,
                })}
              </Button>
            )}
            {(report?.canRetry || report?.state === EngineState.Ready) && (
              <Button
                size="sm"
                disabled={recovering}
                onClick={() => recover(EngineRecoveryAction.Retry)}
              >
                {recovering && <LoaderCircle className="animate-spin" />}
                {report.state === EngineState.Ready
                  ? t('panel.dashboard.engine.diagnostics.restart')
                  : t('panel.dashboard.engine.diagnostics.retry')}
              </Button>
            )}
            {report?.canForceTerminate && (
              <Button
                variant="destructive"
                size="sm"
                disabled={recovering}
                onClick={() => setConfirmForce(true)}
              >
                {t('panel.dashboard.engine.diagnostics.forceRecover')}
              </Button>
            )}
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
