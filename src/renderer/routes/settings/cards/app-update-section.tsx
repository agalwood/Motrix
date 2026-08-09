import { Alert } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { Spinner } from '@renderer/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import type {
  AppUpdateProgress,
  AppUpdateState,
} from '@shared/types/app-update'
import { DownloadIcon, RefreshCwIcon, RotateCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { UpdateChannelSetting } from './update-channel-setting'
import { useAppUpdate } from './use-app-update'

const ACTION_CLASS =
  'transition-transform active:scale-[0.97] motion-reduce:transform-none'

export function AppUpdateSection() {
  const { t } = useTranslation()
  const { state, check, download, install } = useAppUpdate()

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
        <div className="min-w-0 flex-1 pt-0.5">
          <h3
            id="app-update-title"
            className="text-base leading-5 font-semibold tracking-[-0.01em]"
          >
            {statusTitle(state, t)}
          </h3>
          <p className="mt-1 text-xs leading-[1.5] text-muted-foreground">
            {statusDescription(state, t)}
          </p>
        </div>

        <UpdateChannelSetting
          disabled={
            state.phase === 'unsupported' ||
            state.phase === 'checking' ||
            state.phase === 'downloading' ||
            state.phase === 'downloaded'
          }
        >
          <UpdatePrimaryAction
            state={state}
            check={check}
            download={download}
            install={install}
          />
        </UpdateChannelSetting>
      </div>

      {state.phase === 'downloading' && (
        <div className="mt-4">
          <DownloadProgress progress={state.progress} />
        </div>
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

interface UpdatePrimaryActionProps {
  state: AppUpdateState
  check: () => Promise<unknown>
  download: () => Promise<unknown>
  install: () => Promise<unknown>
}

function UpdatePrimaryAction({
  state,
  check,
  download,
  install,
}: UpdatePrimaryActionProps) {
  const { t } = useTranslation()

  if (state.phase === 'idle' || state.phase === 'up-to-date') {
    return (
      <TooltipProvider delay={300}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                className={ACTION_CLASS}
                aria-label={t('settings.about.update.check')}
                onClick={() => void check()}
              />
            }
          >
            <RefreshCwIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{t('settings.about.update.check')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  if (state.phase === 'checking') {
    return (
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        aria-label={t('settings.about.update.checking')}
        disabled
      >
        <Spinner aria-hidden="true" />
      </Button>
    )
  }

  if (state.phase === 'available') {
    return (
      <Button
        type="button"
        size="sm"
        className={ACTION_CLASS}
        onClick={() => void download()}
      >
        <DownloadIcon aria-hidden="true" />
        {t('settings.about.update.download')}
      </Button>
    )
  }

  if (state.phase === 'downloaded') {
    return (
      <Button
        type="button"
        size="sm"
        className={ACTION_CLASS}
        onClick={() => void install()}
      >
        <RotateCwIcon aria-hidden="true" />
        {t('settings.about.update.restart')}
      </Button>
    )
  }

  if (state.phase === 'cancelled' || state.phase === 'error') {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={ACTION_CLASS}
        onClick={() => void (state.availableVersion ? download() : check())}
      >
        <RefreshCwIcon aria-hidden="true" />
        {t('settings.about.update.retry')}
      </Button>
    )
  }

  return null
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

function DownloadProgress({
  progress = { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 },
}: {
  progress?: AppUpdateProgress
}) {
  const { t } = useTranslation()
  const percent = Math.round(progress.percent)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>{t('settings.about.update.downloading')}</span>
        <span className="tabular-nums text-muted-foreground">{percent}%</span>
      </div>
      <Progress
        value={progress.percent}
        aria-label={t('settings.about.update.downloadProgress')}
      />
      <p className="text-xs tabular-nums text-muted-foreground">
        {t('settings.about.update.progressDetail', {
          transferred: formatBytes(progress.transferred),
          total: formatBytes(progress.total),
          speed: formatBytes(progress.bytesPerSecond),
        })}
      </p>
    </div>
  )
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1
  )
  const scaled = value / 1024 ** unitIndex
  return `${scaled >= 10 || unitIndex === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unitIndex]}`
}

export function shouldShowAppUpdate(target: 'electron' | 'web'): boolean {
  return target === 'electron'
}
