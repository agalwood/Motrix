import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@renderer/components/ui/alert'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { ButtonGroup } from '@renderer/components/ui/button-group'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@renderer/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import {
  CLI_INSTALL_PACKAGE_MANAGERS,
  CliInstallCapability,
  type CliInstallPackageManager,
  CliPackageManager,
  CliToolPhase,
  CliToolReason,
  type CliToolStatus,
} from '@shared/types/cli-tool'
import { ChevronRight, CircleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCliTool } from './use-cli-tool'

function badgeVariant(phase: CliToolPhase) {
  if (phase === CliToolPhase.Error) return 'destructive' as const
  if (
    phase === CliToolPhase.Ready ||
    phase === CliToolPhase.NeedsAttention ||
    phase === CliToolPhase.ManualOnly
  ) {
    return 'outline' as const
  }
  if (phase === CliToolPhase.Checking || phase === CliToolPhase.Installing) {
    return 'secondary' as const
  }
  return 'default' as const
}

function statusKey(phase: CliToolPhase): string {
  switch (phase) {
    case CliToolPhase.Checking:
      return 'settings.integration.cli.tool.status.checking'
    case CliToolPhase.Ready:
      return 'settings.integration.cli.tool.status.ready'
    case CliToolPhase.Installing:
      return 'settings.integration.cli.tool.status.installing'
    case CliToolPhase.Installed:
      return 'settings.integration.cli.tool.status.installed'
    case CliToolPhase.NeedsAttention:
      return 'settings.integration.cli.tool.status.needsAttention'
    case CliToolPhase.ManualOnly:
      return 'settings.integration.cli.tool.status.manualOnly'
    case CliToolPhase.Error:
      return 'settings.integration.cli.tool.status.error'
  }
}

function reasonKey(reason: CliToolReason | null): string {
  switch (reason) {
    case CliToolReason.NodeMissing:
      return 'settings.integration.cli.tool.reason.nodeMissing'
    case CliToolReason.NodeTooOld:
      return 'settings.integration.cli.tool.reason.nodeTooOld'
    case CliToolReason.ManagerMissing:
      return 'settings.integration.cli.tool.reason.managerMissing'
    case CliToolReason.Sandboxed:
      return 'settings.integration.cli.tool.reason.sandboxed'
    case CliToolReason.UnsupportedWeb:
      return 'settings.integration.cli.tool.reason.unsupportedWeb'
    case CliToolReason.Permission:
      return 'settings.integration.cli.tool.reason.permission'
    case CliToolReason.Network:
      return 'settings.integration.cli.tool.reason.network'
    case CliToolReason.Timeout:
      return 'settings.integration.cli.tool.reason.timeout'
    case CliToolReason.PathMissing:
      return 'settings.integration.cli.tool.reason.pathMissing'
    case CliToolReason.PathShadowed:
      return 'settings.integration.cli.tool.reason.pathShadowed'
    case CliToolReason.VerifyFailed:
      return 'settings.integration.cli.tool.reason.verifyFailed'
    case CliToolReason.InstallFailed:
      return 'settings.integration.cli.tool.reason.installFailed'
    case CliToolReason.Unknown:
    case null:
      return 'settings.integration.cli.tool.reason.unknown'
  }
}

function actionKey(phase: CliToolPhase): string {
  if (phase === CliToolPhase.Ready) {
    return 'settings.integration.cli.tool.action.install'
  }
  if (phase === CliToolPhase.Installing) {
    return 'settings.integration.cli.tool.action.installing'
  }
  if (phase === CliToolPhase.Checking) {
    return 'settings.integration.cli.tool.action.checking'
  }
  return 'settings.integration.cli.tool.action.checkAgain'
}

function managerKey(manager: CliInstallPackageManager): string {
  switch (manager) {
    case CliPackageManager.Npm:
      return 'settings.integration.cli.tool.manager.npm'
    case CliPackageManager.Pnpm:
      return 'settings.integration.cli.tool.manager.pnpm'
    case CliPackageManager.Yarn:
      return 'settings.integration.cli.tool.manager.yarn'
    case CliPackageManager.Bun:
      return 'settings.integration.cli.tool.manager.bun'
    case CliPackageManager.Volta:
      return 'settings.integration.cli.tool.manager.volta'
  }
}

function shouldShowAlert(status: CliToolStatus): boolean {
  return (
    status.phase === CliToolPhase.ManualOnly ||
    status.phase === CliToolPhase.NeedsAttention ||
    status.phase === CliToolPhase.Error
  )
}

export function CliToolSection() {
  const { t } = useTranslation()
  const {
    status,
    selectedManager,
    selectedCommand,
    isRefreshing,
    selectManager,
    install,
    refresh,
  } = useCliTool()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const isChecking = status.phase === CliToolPhase.Checking
  const isInstalling = status.phase === CliToolPhase.Installing
  const isInstalled = status.phase === CliToolPhase.Installed
  const isReady = status.phase === CliToolPhase.Ready
  const disabled = isChecking || isInstalling || isRefreshing
  const hasMetadata = Boolean(status.version || status.executablePath)
  const managerItems = CLI_INSTALL_PACKAGE_MANAGERS.map((manager) => ({
    value: manager,
    label: t(managerKey(manager)),
  }))

  const runAction = () => {
    void (isReady ? install() : refresh())
  }

  return (
    <Card className="gap-3 py-4 shadow-none">
      <CardHeader className="gap-1 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle>{t('settings.integration.cli.tool.title')}</CardTitle>
          <span className="shrink-0" role="status" aria-live="polite">
            <Badge variant={badgeVariant(status.phase)}>
              {t(statusKey(status.phase))}
            </Badge>
          </span>
        </div>
        <CardDescription>
          {t('settings.integration.cli.tool.description')}
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            size="xs"
            variant={isReady || isInstalling ? 'default' : 'outline'}
            disabled={disabled}
            onClick={runAction}
          >
            {(isChecking || isInstalling || isRefreshing) && (
              <Spinner
                data-icon="inline-start"
                role="presentation"
                aria-hidden="true"
              />
            )}
            {t(
              isRefreshing && !isInstalling
                ? 'settings.integration.cli.tool.action.checking'
                : actionKey(status.phase)
            )}
          </Button>
        </CardAction>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {isRefreshing
            ? t('settings.integration.cli.tool.action.checking')
            : null}
        </span>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 px-4">
        <ButtonGroup className="w-full">
          <ButtonGroup className="min-w-0 flex-1">
            <Select
              items={managerItems}
              value={selectedManager}
              disabled={disabled}
              onValueChange={(manager) => {
                if (manager !== null) selectManager(manager)
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-32 font-mono"
                aria-label={t('settings.integration.cli.tool.managerLabel')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectGroup>
                  {managerItems.map(({ label, value }) => {
                    const option = status.managerOptions.find(
                      ({ manager }) => manager === value
                    )
                    const unavailableForDirectInstall =
                      isReady &&
                      status.capability === CliInstallCapability.Direct &&
                      !option?.available

                    return (
                      <SelectItem
                        key={value}
                        value={value}
                        disabled={unavailableForDirectInstall}
                      >
                        {label}
                      </SelectItem>
                    )
                  })}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Input
              readOnly
              value={selectedCommand}
              aria-label={t('settings.integration.cli.tool.commandLabel')}
              className="h-8 font-mono text-xs"
            />
          </ButtonGroup>
          <ButtonGroup className="shrink-0">
            <CopyButton
              type="button"
              size="icon-sm"
              variant="outline"
              content={selectedCommand}
              aria-label={t('settings.integration.cli.tool.copyCommand')}
              title={t('settings.integration.cli.tool.copyCommand')}
            />
          </ButtonGroup>
        </ButtonGroup>

        {hasMetadata && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {status.version && (
              <>
                <dt className="text-muted-foreground">
                  {t('settings.integration.cli.tool.metadata.version')}
                </dt>
                <dd className="font-mono">{status.version}</dd>
              </>
            )}
            {status.executablePath && (
              <>
                <dt className="text-muted-foreground">
                  {t('settings.integration.cli.tool.metadata.path')}
                </dt>
                <dd
                  className="min-w-0 break-all font-mono"
                  title={status.executablePath}
                >
                  {status.executablePath}
                </dd>
              </>
            )}
            {status.packageManager !== CliPackageManager.Unknown && (
              <>
                <dt className="text-muted-foreground">
                  {t('settings.integration.cli.tool.metadata.manager')}
                </dt>
                <dd>{status.packageManager}</dd>
              </>
            )}
          </dl>
        )}

        {shouldShowAlert(status) && (
          <Alert
            variant={
              status.phase === CliToolPhase.Error ? 'destructive' : 'default'
            }
          >
            <CircleAlert aria-hidden="true" />
            <AlertTitle>
              {t('settings.integration.cli.tool.attentionTitle')}
            </AlertTitle>
            <AlertDescription>
              {t(reasonKey(status.reason), {
                version:
                  status.nodeVersion ??
                  t('settings.integration.cli.tool.metadata.unknown'),
              })}
            </AlertDescription>
          </Alert>
        )}

        {status.detail && (
          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
            <CollapsibleTrigger
              render={<Button type="button" variant="ghost" size="xs" />}
            >
              <ChevronRight
                data-icon="inline-start"
                aria-hidden="true"
                className={cn(
                  'transition-transform',
                  detailsOpen && 'rotate-90'
                )}
              />
              {t(
                detailsOpen
                  ? 'settings.integration.cli.tool.diagnostics.hide'
                  : 'settings.integration.cli.tool.diagnostics.show'
              )}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
                {status.detail}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}

        {isInstalled && (
          <p className="text-xs text-muted-foreground">
            {t('settings.integration.cli.tool.successGuidance')}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
