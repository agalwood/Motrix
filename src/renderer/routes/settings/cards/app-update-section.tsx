import { Alert } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import type { AppUpdateState } from '@shared/types/app-update'
import type { AppUpdateChannel } from '@shared/types/settings'
import { DownloadIcon, RefreshCwIcon, RotateCwIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UpdateChannelSetting } from './update-channel-setting'
import { useAppUpdate } from './use-app-update'

export function AppUpdateSection() {
  const { t } = useTranslation()
  const { state, check, download, install } = useAppUpdate()
  const betaWarningId = useId()
  const [channel, setChannel] = useState<AppUpdateChannel>('stable')

  return (
    <section
      className="px-6 py-5"
      aria-labelledby="app-update-title"
      aria-live="polite"
    >
      <p className="text-xs font-medium text-muted-foreground">
        {t('settings.about.update.title')}
      </p>

      <div className="mt-3 flex flex-col items-start gap-4 sm:flex-row sm:justify-between">
        <div className="min-h-20 min-w-0 flex-1 pt-0.5 sm:min-h-16">
          <h3
            id="app-update-title"
            className="text-base leading-5 font-semibold tracking-[-0.01em]"
          >
            {statusTitle(state, t)}
          </h3>
          <p className="mt-1 text-xs leading-normal text-muted-foreground">
            {statusDescription(state, t)}
          </p>
        </div>

        <UpdateChannelSetting
          warningId={betaWarningId}
          onChannelChanged={setChannel}
          disabled={
            state.phase === 'unsupported' ||
            state.phase === 'checking' ||
            state.phase === 'downloading' ||
            state.phase === 'downloaded'
          }
        >
          <UpdateActionButton
            state={state}
            check={check}
            download={download}
            install={install}
          />
        </UpdateChannelSetting>
      </div>

      {channel === 'beta' && (
        <Alert
          id={betaWarningId}
          className="mt-2 border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-4 text-amber-900 dark:text-amber-200"
        >
          {t('settings.about.update.channelBetaWarning')}
        </Alert>
      )}

      {(state.phase === 'cancelled' || state.phase === 'error') && (
        <Alert
          className="mt-4"
          variant={state.phase === 'error' ? 'destructive' : 'default'}
        >
          {state.phase === 'error'
            ? t('settings.about.update.error', {
                message: state.error?.message,
              })
            : t('settings.about.update.cancelled')}
        </Alert>
      )}
    </section>
  )
}

interface UpdateActionButtonProps {
  state: AppUpdateState
  check: () => Promise<unknown>
  download: () => Promise<unknown>
  install: () => Promise<unknown>
}

interface UpdateAction {
  label: ReactNode
  accessibleLabel?: string
  icon: ReactNode
  disabled?: boolean
  variant: 'default' | 'outline'
  run?: () => Promise<unknown>
}

function UpdateActionButton({
  state,
  check,
  download,
  install,
}: UpdateActionButtonProps) {
  const { t } = useTranslation()

  const progress =
    state.phase === 'downloading'
      ? Math.min(100, Math.max(0, Math.round(state.progress?.percent ?? 0)))
      : undefined
  const action = updateAction(state, progress, { check, download, install }, t)

  return action ? (
    <Button
      type="button"
      size="sm"
      variant={action.variant}
      className={cn(
        'h-7! gap-1.5 rounded-md! px-2 text-xs shadow-none [&_svg]:size-3.5!',
        state.phase !== 'unsupported' && 'disabled:opacity-100'
      )}
      aria-label={action.accessibleLabel}
      aria-busy={
        state.phase === 'checking' || state.phase === 'downloading'
          ? true
          : undefined
      }
      disabled={action.disabled}
      onClick={action.run ? () => void action.run?.() : undefined}
    >
      {action.icon}
      {action.label}
    </Button>
  ) : null
}

function updateAction(
  state: AppUpdateState,
  progress: number | undefined,
  actions: {
    check: () => Promise<unknown>
    download: () => Promise<unknown>
    install: () => Promise<unknown>
  },
  t: ReturnType<typeof useTranslation>['t']
): UpdateAction | null {
  switch (state.phase) {
    case 'unsupported':
      return {
        label: t('settings.about.update.checkAction'),
        accessibleLabel: t('settings.about.update.check'),
        icon: <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />,
        disabled: true,
        variant: 'default',
      }
    case 'checking':
      return {
        label: t('settings.about.update.checking'),
        icon: <Spinner data-icon="inline-start" aria-hidden="true" />,
        disabled: true,
        variant: 'default',
      }
    case 'available':
      return {
        label: t('settings.about.update.download'),
        icon: <DownloadIcon data-icon="inline-start" aria-hidden="true" />,
        variant: 'default',
        run: actions.download,
      }
    case 'downloading':
      return {
        label: <span className="tabular-nums">{progress}%</span>,
        accessibleLabel: `${t('settings.about.update.downloading')} ${progress}%`,
        icon: <DownloadIcon data-icon="inline-start" aria-hidden="true" />,
        disabled: true,
        variant: 'default',
      }
    case 'downloaded':
      return {
        label: t('settings.about.update.restart'),
        icon: <RotateCwIcon data-icon="inline-start" aria-hidden="true" />,
        variant: 'default',
        run: actions.install,
      }
    case 'cancelled':
    case 'error':
      return {
        label: t('settings.about.update.retry'),
        icon: <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />,
        variant: 'default',
        run: state.availableVersion ? actions.download : actions.check,
      }
    default:
      return {
        label: t('settings.about.update.checkAction'),
        accessibleLabel: t('settings.about.update.check'),
        icon: <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />,
        variant: 'default',
        run: actions.check,
      }
  }
}

function statusTitle(
  state: AppUpdateState,
  t: ReturnType<typeof useTranslation>['t']
): string {
  switch (state.phase) {
    case 'unsupported':
      return t('settings.about.update.unsupportedTitle')
    case 'checking':
      return t('settings.about.update.checkingTitle')
    case 'up-to-date':
      return t('settings.about.update.upToDateTitle')
    case 'available':
      return t('settings.about.update.availableTitle', {
        version: state.availableVersion,
      })
    case 'downloading':
      return t('settings.about.update.downloadingTitle', {
        version: state.availableVersion,
      })
    case 'downloaded':
      return t('settings.about.update.downloadedTitle')
    case 'cancelled':
      return t('settings.about.update.cancelledTitle')
    case 'error':
      return t('settings.about.update.errorTitle')
    default:
      return t('settings.about.update.idleTitle')
  }
}

function statusDescription(
  state: AppUpdateState,
  t: ReturnType<typeof useTranslation>['t']
): string {
  switch (state.phase) {
    case 'unsupported':
      return t('settings.about.update.unsupported')
    case 'checking':
      return t('settings.about.update.checkingDescription')
    case 'up-to-date':
      return t('settings.about.update.upToDate', {
        version: state.currentVersion,
      })
    case 'available':
      return t('settings.about.update.availableDescription')
    case 'downloading':
      return t('settings.about.update.downloadingDescription', {
        version: state.availableVersion,
      })
    case 'downloaded':
      return t('settings.about.update.downloaded', {
        version: state.availableVersion,
      })
    case 'cancelled':
      return t('settings.about.update.cancelledDescription')
    case 'error':
      return t('settings.about.update.errorDescription')
    default:
      return t('settings.about.update.idle', {
        version: state.currentVersion,
      })
  }
}

export function shouldShowAppUpdate(target: 'electron' | 'web'): boolean {
  return target === 'electron'
}
