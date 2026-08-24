import { Button } from '@renderer/components/ui/button'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@renderer/components/ui/form'
import { Switch } from '@renderer/components/ui/switch'
import { useTransportMirror } from '@renderer/hooks/use-transport-mirror'
import { transport } from '@renderer/lib/transport'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { LinuxDefaultAssociations } from '@shared/types/linux-default-apps'
import type { WindowsDefaultAssociations } from '@shared/types/windows-default-apps'
import { CircleQuestionMark } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { IntegrationFormValues } from './integration-dialog'

type AssociationDisplayState =
  | 'checking'
  | 'setupRequired'
  | 'default'
  | 'notDefault'
  | 'unavailable'

const ASSOCIATION_STATUS_CLASS: Record<AssociationDisplayState, string> = {
  checking: 'bg-muted-foreground/50',
  setupRequired: 'bg-amber-500',
  default: 'bg-emerald-500',
  notDefault: 'bg-muted-foreground/50',
  unavailable: 'bg-amber-500',
}

const ASSOCIATION_STATUS_KEY = {
  checking: 'settings.integration.system.associationChecking',
  setupRequired: 'settings.integration.system.associationSetupRequired',
  default: 'settings.integration.system.associationDefault',
  notDefault: 'settings.integration.system.associationNotDefault',
  unavailable: 'settings.integration.system.associationUnavailable',
} as const

function associationDisplayState(
  status: WindowsDefaultAssociations | LinuxDefaultAssociations | null,
  isDefault: boolean | null
): AssociationDisplayState {
  if (!status) return 'checking'
  if (!status.supported) return 'unavailable'
  if (status.registered === null) return 'unavailable'
  if (!status.registered) return 'setupRequired'
  if (isDefault === null) return 'unavailable'
  return isDefault ? 'default' : 'notDefault'
}

export interface SystemProtocolsSectionProps {
  refreshRevision?: number
}

export function SystemProtocolsSection({
  refreshRevision = 0,
}: SystemProtocolsSectionProps) {
  const { t } = useTranslation()
  const form = useFormContext<IntegrationFormValues>()
  const isWindows = transport.platform === 'win32'
  const isLinux = transport.platform === 'linux'
  const [windowsAssociations, setWindowsAssociations] =
    useState<WindowsDefaultAssociations | null>(null)
  const [linuxAssociations, setLinuxAssociations] =
    useState<LinuxDefaultAssociations | null>(null)
  const [linuxAction, setLinuxAction] = useState<
    'idle' | 'running' | 'set' | 'fallback' | 'failed'
  >('idle')
  const { refresh: refreshWindowsAssociations } = useTransportMirror({
    events: [],
    refetchOnFocus: isWindows,
    retryOnce: true,
    load: async (stale) => {
      if (!isWindows) return
      const status = (await transport.invoke(
        Queries.GetWindowsDefaultAssociations
      )) as WindowsDefaultAssociations
      if (!stale()) setWindowsAssociations(status)
    },
  })
  const { refresh: refreshLinuxAssociations } = useTransportMirror({
    events: [],
    refetchOnFocus: isLinux,
    retryOnce: true,
    load: async (stale) => {
      if (!isLinux) return
      const status = (await transport.invoke(
        Queries.GetLinuxDefaultAssociations
      )) as LinuxDefaultAssociations
      if (!stale()) setLinuxAssociations(status)
    },
  })

  useEffect(() => {
    if (refreshRevision > 0 && isLinux) void refreshLinuxAssociations()
  }, [isLinux, refreshLinuxAssociations, refreshRevision])

  const associationLabel =
    isWindows || isLinux
      ? t(
          isWindows
            ? 'settings.integration.system.defaultAssociationsWindows'
            : 'settings.integration.system.defaultAssociationsLinux'
        )
      : t('settings.integration.system.torrentAssociation')
  let associationDescription = t(
    'settings.integration.system.torrentAssociationDesc'
  )
  if (transport.platform === 'darwin') {
    associationDescription = t(
      'settings.integration.system.torrentAssociationMacDesc'
    )
  } else if (isWindows) {
    associationDescription = t(
      'settings.integration.system.defaultAssociationsWindowsDesc'
    )
  } else if (isLinux) {
    const kind = linuxAssociations?.packageKind
    associationDescription = t(
      linuxAssociations === null
        ? 'settings.integration.system.defaultAssociationsLinuxCheckingDesc'
        : !linuxAssociations.supported
          ? 'settings.integration.system.defaultAssociationsLinuxUnavailableDesc'
          : kind === 'appimage'
            ? 'settings.integration.system.defaultAssociationsLinuxAppImageDesc'
            : kind === 'flatpak' || kind === 'snap'
              ? 'settings.integration.system.defaultAssociationsLinuxSandboxDesc'
              : 'settings.integration.system.defaultAssociationsLinuxDesc'
    )
  }

  const handleOpenSystemSettings = async () => {
    if (isLinux) setLinuxAction('running')
    try {
      const channel =
        isLinux && linuxAssociations?.packageKind === 'appimage'
          ? Commands.EnableAppImageIntegration
          : Commands.RequestDefaultTorrentHandler
      const result = (await transport.invoke(channel)) as {
        action?: string
        supported?: boolean
        status?: string | null
      }
      if (isWindows) await refreshWindowsAssociations()
      if (isLinux) {
        await refreshLinuxAssociations()
        if (channel === Commands.EnableAppImageIntegration) {
          setLinuxAction(
            result.supported === true && result.status === 'healthy'
              ? 'set'
              : 'failed'
          )
        } else {
          setLinuxAction(result.action === 'set' ? 'set' : 'fallback')
        }
      }
    } catch {
      if (isLinux) setLinuxAction('failed')
    }
  }

  const associations = isWindows ? windowsAssociations : linuxAssociations
  const associationRows = [
    {
      id: 'torrent',
      label: t('settings.integration.system.torrentFiles'),
      isDefault: associations?.torrent ?? null,
    },
    {
      id: 'magnet',
      label: t('settings.integration.system.magnetLinks'),
      isDefault: associations?.magnet ?? null,
    },
  ] as const

  const linuxPackageLabel = linuxAssociations?.packageKind
    ? t(
        `settings.integration.system.linuxPackage.${linuxAssociations.packageKind}`
      )
    : null
  const showLinuxButton =
    isLinux &&
    linuxAssociations !== null &&
    (linuxAssociations.packageKind !== 'appimage' ||
      (linuxAssociations.registered && linuxAssociations.torrent !== true))
  const isAppImageRepair =
    linuxAssociations?.packageKind === 'appimage' && showLinuxButton
  const linuxCanSet = linuxAssociations?.canSetTorrentDefault === true

  return (
    <div className="space-y-4">
      {!isWindows && (
        <FormField
          control={form.control}
          name="app.protocols.magnet"
          render={({ field }) => (
            <FormItem className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <FormLabel>
                  {t('settings.integration.system.protocolMagnet')}
                </FormLabel>
                <FormDescription className="text-xs">
                  {t(
                    isLinux && linuxAssociations?.packageKind === 'appimage'
                      ? 'settings.integration.system.protocolMagnetAppImageDesc'
                      : isLinux &&
                          (linuxAssociations?.packageKind === 'flatpak' ||
                            linuxAssociations?.packageKind === 'snap')
                        ? 'settings.integration.system.protocolMagnetSandboxDesc'
                        : 'settings.integration.system.protocolMagnetDesc'
                  )}
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium">
            {associationLabel}
            <a
              href={EXTERNAL_URLS.motrix.manual.defaultApplication}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('settings.common.openHelp')}
              className="text-muted-foreground hover:text-foreground"
            >
              <CircleQuestionMark className="size-4" />
            </a>
          </span>
          <p className="text-xs text-muted-foreground">
            {associationDescription}
          </p>
          {(isWindows || isLinux) && (
            <div
              className="mt-2 grid gap-1.5"
              role="status"
              aria-live="polite"
              aria-label={t(
                isWindows
                  ? 'settings.integration.system.associationStatusLabel'
                  : 'settings.integration.system.associationStatusLabelLinux'
              )}
            >
              {linuxPackageLabel && (
                <p className="mb-0.5 text-xs text-muted-foreground">
                  {t('settings.integration.system.linuxPackageDetected', {
                    package: linuxPackageLabel,
                  })}
                </p>
              )}
              {associationRows.map((row) => {
                const state = associationDisplayState(
                  associations,
                  row.isDefault
                )
                return (
                  <div
                    key={row.id}
                    className="flex items-center justify-between gap-6 text-xs"
                  >
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <span
                        className={`size-1.5 rounded-full ${ASSOCIATION_STATUS_CLASS[state]}`}
                        aria-hidden="true"
                      />
                      {t(
                        state === 'setupRequired' && isLinux
                          ? 'settings.integration.system.associationNotRegistered'
                          : ASSOCIATION_STATUS_KEY[state]
                      )}
                    </span>
                  </div>
                )
              })}
              {isLinux &&
                linuxAction !== 'idle' &&
                linuxAction !== 'running' && (
                  <p
                    className={`pt-1 text-xs ${
                      linuxAction === 'set'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : linuxAction === 'failed'
                          ? 'text-destructive'
                          : 'text-muted-foreground'
                    }`}
                  >
                    {t(
                      linuxAction === 'set'
                        ? 'settings.integration.system.linuxActionSet'
                        : linuxAction === 'failed'
                          ? 'settings.integration.system.linuxActionFailed'
                          : 'settings.integration.system.linuxActionFallback'
                    )}
                  </p>
                )}
            </div>
          )}
        </div>
        {(isWindows || showLinuxButton) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isLinux && linuxAction === 'running'}
            onClick={handleOpenSystemSettings}
          >
            {isWindows
              ? t('settings.integration.system.openWindowsSettings')
              : t(
                  isAppImageRepair
                    ? 'settings.integration.system.repairLinuxAssociations'
                    : linuxCanSet
                      ? 'settings.integration.system.setTorrentDefaultLinux'
                      : 'settings.integration.system.viewLinuxInstructions'
                )}
          </Button>
        )}
      </div>
    </div>
  )
}
