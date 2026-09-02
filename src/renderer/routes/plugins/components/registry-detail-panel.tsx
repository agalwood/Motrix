import {
  PANEL_TITLE_CLASS,
  PanelShell,
} from '@renderer/components/desktop-kit/panel/panel-shell'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
import { usePlatformServices } from '@renderer/platform/services'
import { EXTERNAL_URLS } from '@shared/external-urls'
import type { RegistryPluginDTO } from '@shared/schemas/registry'
import { Download, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { registryListing } from '../lib/registry-text'
import { PluginInstallDialog } from '../plugin-install-dialog'
import { PluginAvatar } from './plugin-avatar'

interface Props {
  entry: RegistryPluginDTO
}

/**
 * Detail view for a registry plugin that is not installed — the landing
 * surface of the motrix://plugins/<id> deeplink. Both hosts install through
 * PluginInstallDialog's fixed-source mode and their shell-owned verified
 * registry flow; incompatible entries remain viewable but not installable.
 */
export function RegistryDetailPanel({ entry }: Props) {
  const { t, i18n } = useTranslation()
  const services = usePlatformServices()
  const [installOpen, setInstallOpen] = useState(false)
  const { name, description, features } = registryListing(
    entry.listing,
    i18n.language
  )
  const permissionChips = [
    ...entry.permissions.map((p) => ({ key: `perm:${p}`, label: p })),
    ...entry.optionalPermissions.map((p) => ({
      key: `opt:${p}`,
      label: `${p} · ${t('plugins.registry.optionalTag')}`,
    })),
    ...entry.hostPermissions.map((p) => ({ key: `host:${p}`, label: p })),
  ]

  return (
    <PanelShell
      title={
        <div className="flex h-8 min-w-0 items-center gap-2 compact-header:h-7">
          <h1
            className={`${PANEL_TITLE_CLASS} min-w-0 overflow-x-clip whitespace-nowrap text-ellipsis leading-none`}
          >
            {name}
          </h1>
          <Badge variant="secondary" className="shrink-0">
            {t('plugins.registry.notInstalled')}
          </Badge>
        </div>
      }
      contentClassName="min-h-0 px-6 pb-6"
    >
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full flex-col gap-4 pb-6">
          <Card className="flex flex-col gap-4 p-4">
            <div className="flex items-start gap-3">
              <PluginAvatar
                plugin={{ id: entry.id, name, icon: entry.icon }}
                size={56}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-muted-foreground">
                  {t('plugins.registry.byAuthor', { name: entry.author.name })}
                  {' · '}v{entry.version}
                  {' · '}
                  {t('plugins.registry.updated', { date: entry.updatedAt })}
                </p>
                <p className="mt-1 text-sm">{description}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!entry.compatible && (
                <Badge variant="outline" className="text-muted-foreground">
                  {t('plugins.registry.requires', {
                    range: entry.engines.motrix,
                  })}
                </Badge>
              )}
              <Button
                size="sm"
                disabled={!entry.compatible}
                onClick={() => setInstallOpen(true)}
                data-testid="registry-install-btn"
              >
                <Download className="size-3.5" />
                {t('plugins.registry.install')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  services.openExternal(
                    `${EXTERNAL_URLS.motrix.plugins}?plugin=${encodeURIComponent(entry.id)}`
                  )
                }
              >
                <ExternalLink className="size-3.5" />
                {t('plugins.registry.viewOnWebsite')}
              </Button>
            </div>
          </Card>

          {features.length > 0 && (
            <Card className="flex flex-col gap-2 p-4">
              <h3 className="text-sm font-semibold tracking-tight">
                {t('plugins.registry.featuresTitle')}
              </h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
            </Card>
          )}

          {permissionChips.length > 0 && (
            <Card className="flex flex-col gap-2 p-4">
              <h3 className="text-sm font-semibold tracking-tight">
                {t('plugins.registry.permissionsTitle')}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t('plugins.registry.permissionsPreviewNote')}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {permissionChips.map((chip) => (
                  <span
                    key={chip.key}
                    className="rounded-full border px-2.5 py-0.5 font-mono text-xs text-muted-foreground"
                  >
                    {chip.label}
                  </span>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      <PluginInstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        fixedSource={{ sourceType: 'registry', pluginId: entry.id }}
      />
    </PanelShell>
  )
}
