import { ChevronRight, Settings } from 'lucide-react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { TakeoverConsentDialog } from '@/components/takeover-consent-dialog'
import { TakeoverPairingDialog } from '@/components/takeover-pairing-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useNotificationCapability } from '@/components/useNotificationCapability'
import { cn } from '@/lib/utils'
import {
  CompactContentCard,
  CompactSectionToolbar,
} from '@/popup/CompactPopupLayout'
import type { QuickSettingsController } from '@/popup/useQuickSettings'
import { supportsDownloadTakeover } from '@/shared/platformCapabilities'

export const QUICK_SETTINGS_I18N_KEYS = {
  title: 'popup.tabs.settings',
  takeoverDescription: 'popup.quickSettings.takeoverDescription',
  notificationsDescription: 'popup.quickSettings.notificationsDescription',
  fullSettings: 'popup.quickSettings.fullSettings',
  fullSettingsDescription: 'popup.quickSettings.fullSettingsDescription',
  loadError: 'popup.quickSettings.loadError',
  saveError: 'popup.quickSettings.saveError',
  retry: 'popup.quickSettings.retry',
} as const

export interface QuickSettingRowProps {
  id: string
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}

/** A compact, label-driven switch row shared by every popup quick setting. */
export function QuickSettingRow({
  id,
  title,
  description,
  checked,
  disabled = false,
  onCheckedChange,
}: QuickSettingRowProps): React.ReactElement {
  return (
    <div
      data-slot="quick-setting-row"
      data-disabled={disabled ? 'true' : undefined}
      className="flex min-h-[55px] shrink-0 items-center justify-between gap-3 px-3 py-2 transition-colors hover:bg-muted/30 data-[disabled=true]:opacity-55"
    >
      <span className="min-w-0">
        <label
          id={`${id}-label`}
          htmlFor={id}
          className={cn(
            'block text-xs/4 [overflow-wrap:anywhere] font-medium',
            disabled ? 'cursor-not-allowed' : 'cursor-pointer'
          )}
        >
          {title}
        </label>
        <span
          id={`${id}-description`}
          className="block whitespace-normal text-[10px]/4 [overflow-wrap:anywhere] text-muted-foreground"
          title={description}
        >
          {description}
        </span>
      </span>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
      />
    </div>
  )
}

export interface QuickSettingsPanelProps {
  controller: QuickSettingsController
  onOpenFullSettings: () => void
  className?: string
}

export const QuickSettingsPanel = memo(function QuickSettingsPanel({
  controller,
  onOpenFullSettings,
  className,
}: QuickSettingsPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const { takeover, notifications } = controller
  const { capability } = useNotificationCapability()
  const notificationsSupported = capability.available
  const unavailable = takeover === null || notifications === null
  const controlsDisabled = controller.loading || controller.saving
  const confirmationEnabled = takeover?.downloadMode === 'confirm'
  const inheritedExclusion =
    controller.excludedSite !== null &&
    controller.excludedSite !== controller.currentSite

  return (
    <section className={cn('mt-4 flex h-full min-h-0 flex-col', className)}>
      <CompactSectionToolbar title={t(QUICK_SETTINGS_I18N_KEYS.title)} />

      <CompactContentCard
        data-testid="quick-settings-card"
        className="flex flex-col overflow-y-auto"
      >
        {unavailable ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            {controller.loading ? (
              <>
                <Spinner
                  className="size-5 text-muted-foreground"
                  aria-label={t('popup.loading')}
                />
                <p className="text-xs text-muted-foreground">
                  {t('popup.loading')}
                </p>
              </>
            ) : (
              <>
                <p role="alert" className="text-xs text-muted-foreground">
                  {t(QUICK_SETTINGS_I18N_KEYS.loadError)}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void controller.reload()}
                >
                  {t(QUICK_SETTINGS_I18N_KEYS.retry)}
                </Button>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="shrink-0 divide-y divide-border">
              <QuickSettingRow
                id="quick-download-mode"
                title={t('options.downloadMode.confirm')}
                description={t(
                  controller.taskPanelSupported
                    ? supportsDownloadTakeover()
                      ? 'options.downloadMode.description'
                      : 'safari.confirmDownloadDescription'
                    : supportsDownloadTakeover()
                      ? 'options.taskPanel.unsupported'
                      : 'safari.unsupportedFeature'
                )}
                checked={confirmationEnabled}
                disabled={
                  controlsDisabled ||
                  (!controller.taskPanelSupported && !confirmationEnabled)
                }
                onCheckedChange={(checked) =>
                  void controller.setDownloadMode(
                    checked ? 'confirm' : 'direct'
                  )
                }
              />
              {supportsDownloadTakeover() && (
                <>
                  <QuickSettingRow
                    id="quick-takeover-switch"
                    title={t('options.takeover.enableLabel')}
                    description={t(
                      controller.takeoverSupported
                        ? QUICK_SETTINGS_I18N_KEYS.takeoverDescription
                        : supportsDownloadTakeover()
                          ? 'options.takeover.remoteUnavailableShort'
                          : 'safari.unsupportedFeature'
                    )}
                    checked={controller.takeoverSupported && takeover.enabled}
                    disabled={controlsDisabled || !controller.takeoverSupported}
                    onCheckedChange={(checked) =>
                      void controller.requestTakeoverEnabled(checked)
                    }
                  />
                  <QuickSettingRow
                    id="quick-site-exclusion-switch"
                    title={t('popup.quickSettings.excludeCurrentSite')}
                    description={
                      controller.currentSite === null
                        ? t('popup.quickSettings.noCurrentSite')
                        : t(
                            inheritedExclusion
                              ? 'popup.quickSettings.inheritedExclusion'
                              : 'popup.quickSettings.excludeCurrentSiteDescription',
                            {
                              site: controller.currentSite,
                              domain: controller.excludedSite,
                            }
                          )
                    }
                    checked={controller.excludedSite !== null}
                    disabled={
                      controlsDisabled ||
                      controller.currentSite === null ||
                      inheritedExclusion
                    }
                    onCheckedChange={(checked) =>
                      void controller.setCurrentSiteExcluded(checked)
                    }
                  />
                </>
              )}
              <QuickSettingRow
                id="quick-task-panel-switch"
                title={t('options.taskPanel.openAfterSubmit')}
                description={t(
                  controller.taskPanelSupported
                    ? supportsDownloadTakeover()
                      ? 'popup.quickSettings.taskPanelDescription'
                      : 'safari.taskPanelDescription'
                    : supportsDownloadTakeover()
                      ? 'options.taskPanel.unsupported'
                      : 'safari.unsupportedFeature'
                )}
                checked={takeover.openTaskPanelAfterSubmit}
                disabled={controlsDisabled || !controller.taskPanelSupported}
                onCheckedChange={(checked) =>
                  void controller.setOpenTaskPanelAfterSubmit(checked)
                }
              />
              {notificationsSupported && (
                <QuickSettingRow
                  id="quick-notifications-master-switch"
                  title={t('options.notifications.masterLabel')}
                  description={t(
                    capability.authorization === 'authorized'
                      ? QUICK_SETTINGS_I18N_KEYS.notificationsDescription
                      : `options.notifications.${capability.authorization === 'denied' ? 'nativeDenied' : 'nativeNotDetermined'}`
                  )}
                  checked={notificationsSupported && notifications.master}
                  disabled={
                    controlsDisabled ||
                    (capability.authorization !== 'authorized' &&
                      !notifications.master)
                  }
                  onCheckedChange={(checked) =>
                    void controller.setNotification('master', checked)
                  }
                />
              )}
            </div>
            <Button
              data-testid="full-settings-row"
              type="button"
              variant="ghost"
              className="sticky bottom-0 z-10 mt-auto h-auto min-h-[63px] w-full shrink-0 justify-start whitespace-normal rounded-none border-x-0 border-t border-b-0 border-border bg-card px-3 py-2 text-start hover:bg-muted"
              onClick={onOpenFullSettings}
            >
              <Settings
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs/4 font-medium">
                  {t(QUICK_SETTINGS_I18N_KEYS.fullSettings)}
                </span>
                <span className="block whitespace-normal text-[10px]/4 [overflow-wrap:anywhere] font-normal text-muted-foreground">
                  {t(QUICK_SETTINGS_I18N_KEYS.fullSettingsDescription)}
                </span>
              </span>
              <ChevronRight
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </Button>
          </>
        )}
      </CompactContentCard>

      {controller.error?.operation === 'save' && (
        <p
          role="alert"
          className="mt-1 shrink-0 px-1 [overflow-wrap:anywhere] text-[10px]/4 text-destructive"
        >
          {t(QUICK_SETTINGS_I18N_KEYS.saveError)}
        </p>
      )}

      <TakeoverPairingDialog
        open={controller.pairingRequired && controller.takeoverSupported}
        onCancel={controller.cancelTakeoverPairing}
      />
      <TakeoverConsentDialog
        open={controller.consentRequired && controller.takeoverSupported}
        saving={controller.saving}
        onConfirm={() => void controller.confirmTakeoverConsent()}
        onCancel={controller.cancelTakeoverConsent}
      />
    </section>
  )
})
