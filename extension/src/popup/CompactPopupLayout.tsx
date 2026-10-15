import { ListTodo, Radio, Settings } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { supportsDownloadTakeover } from '@/shared/platformCapabilities'

export type PopupTab = 'tasks' | 'sniffer' | 'settings'

export function CompactPopupHeader({
  backend,
  takeoverChecked,
  takeoverDisabled,
  takeoverSupported = true,
  onTakeoverChange,
  onOpenSettings,
}: {
  backend: ReactNode
  takeoverChecked: boolean
  takeoverDisabled?: boolean
  takeoverSupported?: boolean
  onTakeoverChange: (checked: boolean) => void
  onOpenSettings: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const unavailableKey = supportsDownloadTakeover()
    ? 'options.takeover.remoteUnavailable'
    : 'safari.unsupportedFeature'

  return (
    <header className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
      <div className="w-[176px] min-w-0 flex-none">{backend}</div>
      <div className="flex min-w-0 max-w-full flex-[1_1_auto] items-center justify-end gap-4">
        {supportsDownloadTakeover() && (
          <div
            className="flex min-h-8 min-w-0 flex-1 items-center justify-end gap-2 text-sm font-normal"
            title={takeoverSupported ? undefined : t(unavailableKey)}
          >
            {!takeoverSupported && (
              <span id="popup-takeover-unavailable" className="sr-only">
                {t(unavailableKey)}
              </span>
            )}
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {t('popup.takeover.label')}
            </span>
            <Switch
              id="popup-takeover-switch"
              data-testid="takeover-switch"
              checked={takeoverChecked}
              disabled={takeoverDisabled}
              onCheckedChange={onTakeoverChange}
              aria-label={t('popup.takeover.aria')}
              aria-describedby={
                takeoverSupported ? undefined : 'popup-takeover-unavailable'
              }
            />
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="size-8 shrink-0 text-muted-foreground"
          aria-label={t('popup.settings')}
          title={t('popup.settings')}
          onClick={onOpenSettings}
        >
          <Settings className="size-[18px]" aria-hidden="true" />
        </Button>
      </div>
    </header>
  )
}

export function CompactSectionToolbar({
  title,
  controls,
  action,
  className,
}: {
  title: string
  controls?: ReactNode
  action?: ReactNode
  className?: string
}): React.ReactElement {
  return (
    <div
      data-testid="compact-section-toolbar"
      className={cn(
        'flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-2',
        className
      )}
    >
      <h1 className="min-w-0 flex-[1_1_auto] text-lg/6 font-medium [overflow-wrap:anywhere]">
        {title}
      </h1>
      {(controls || action) && (
        <div className="flex min-w-0 max-w-full flex-[1_1_auto] items-center justify-end gap-3">
          {controls && <div className="min-w-0 flex-1">{controls}</div>}
          {action !== undefined && action !== null ? (
            <div className="flex size-8 shrink-0 items-center justify-center">
              {action}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function CompactContentCard({
  className,
  children,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      {...props}
      className={cn(
        'mt-3 min-h-48 min-w-0 flex-1 overflow-hidden rounded-[12px] border border-border bg-card shadow-card',
        className
      )}
    >
      {children}
    </div>
  )
}

export function PopupBottomNavigation(): React.ReactElement {
  const { t } = useTranslation()

  return (
    <TabsList
      data-testid="bottom-tabs"
      className="mx-auto mt-2 grid min-h-9 w-max min-w-0 max-w-full shrink-0 grid-cols-3 items-stretch gap-[3px] rounded-[12px] bg-tab-background p-[3px] group-data-horizontal/tabs:h-auto"
    >
      <TabsTrigger
        value="tasks"
        aria-label={t('popup.tabs.tasks')}
        title={t('popup.tabs.tasks')}
        className="h-auto min-h-[30px] min-w-0 w-full flex-none flex-wrap gap-1 rounded-[8px] px-2 whitespace-normal text-xs font-normal shadow-none group-data-[variant=default]/tabs-list:data-active:shadow-xs"
      >
        <ListTodo className="size-3.5" aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {t('popup.tabs.tasks')}
        </span>
      </TabsTrigger>
      <TabsTrigger
        value="sniffer"
        aria-label={t('popup.tabs.sniffer')}
        title={t('popup.tabs.sniffer')}
        className="h-auto min-h-[30px] min-w-0 w-full flex-none flex-wrap gap-1 rounded-[8px] px-2 whitespace-normal text-xs font-normal shadow-none group-data-[variant=default]/tabs-list:data-active:shadow-xs"
      >
        <Radio className="size-3.5" aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {t('popup.tabs.sniffer')}
        </span>
      </TabsTrigger>
      <TabsTrigger
        value="settings"
        aria-label={t('popup.tabs.settings')}
        title={t('popup.tabs.settings')}
        className="h-auto min-h-[30px] min-w-0 w-full flex-none flex-wrap gap-1 rounded-[8px] px-2 whitespace-normal text-xs font-normal shadow-none group-data-[variant=default]/tabs-list:data-active:shadow-xs"
      >
        <Settings className="size-3.5" aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {t('popup.tabs.settings')}
        </span>
      </TabsTrigger>
    </TabsList>
  )
}
