import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
import { Switch } from '@renderer/components/ui/switch'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type { PluginListDTO } from '@shared/types/plugin'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  computePluginAudience,
  type PrimaryActionKind,
  truncateOneLine,
} from '../lib/audience'
import { usePluginsStore } from '../store'
import { PluginAudienceBadge } from './plugin-audience-badge'
import { PluginAvatar } from './plugin-avatar'
import { PluginStatusDot } from './plugin-status-dot'

interface Props {
  plugin: PluginListDTO
  hasSchema: boolean
}

const PRIMARY_ACTION_TAB: Partial<Record<PrimaryActionKind, string>> = {
  reviewAccess: '?tab=access',
  grantAccess: '?tab=access',
  settings: '?tab=settings',
  viewIssue: '?tab=logs',
}

export function PluginCard({ plugin, hasSchema }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const applyStatus = usePluginsStore((s) => s.applyStatus)
  // Real grants — store is hydrated by usePlugins via Queries.ListPluginGrants.
  // Without this the audience falsely flags every plugin-with-optional-perms
  // as needing "Grant access" (deriveTone treats `undefined` grants as
  // every optional permission ungranted).
  const grants = usePluginsStore((s) => s.grants[plugin.id])
  const update = usePluginsStore((s) => s.updates[plugin.id])
  const audience = computePluginAudience(
    plugin,
    undefined,
    t,
    grants,
    hasSchema
  )
  const oneLine = truncateOneLine(plugin.description, 90)

  async function toggleEnabled(next: boolean) {
    await transport.invoke(
      next ? Commands.EnablePlugin : Commands.DisablePlugin,
      plugin.id
    )
    applyStatus(plugin.id, next ? 'inactive' : 'disabled', undefined, next)
  }

  function handleCardClick() {
    navigate(`/plugins/${plugin.id}`)
  }

  function handlePrimary(e: ReactMouseEvent) {
    e.stopPropagation()
    const kind = audience.primaryAction.kind
    if (kind === 'turnOn') {
      toggleEnabled(true)
      return
    }
    navigate(`/plugins/${plugin.id}${PRIMARY_ACTION_TAB[kind] ?? ''}`)
  }

  function stopPropagation(e: ReactMouseEvent) {
    e.stopPropagation()
  }

  return (
    <Card
      className="cursor-pointer gap-0 rounded-lg p-4 space-y-4 shadow-none transition-colors hover:bg-muted/30"
      onClick={handleCardClick}
    >
      <div className="grid grid-cols-[40px_1fr_auto] items-start gap-3">
        <PluginAvatar plugin={plugin} size={40} />
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 truncate text-sm font-medium leading-5">
            {plugin.name}
            <PluginStatusDot status={plugin.status} enabled={plugin.enabled} />
            {update && (
              <Badge variant="secondary" className="shrink-0">
                {t('plugins.registry.updateAvailable')}
              </Badge>
            )}
          </h3>

          <p className="mt-0.5 text-xs text-muted-foreground">
            v{plugin.version} · {plugin.id}
          </p>
        </div>

        <Switch
          checked={plugin.enabled}
          aria-label={t('plugins.detail.enabled')}
          onClick={stopPropagation}
          onCheckedChange={toggleEnabled}
        />
      </div>

      <p className="line-clamp-2 text-xs text-muted-foreground">{oneLine}</p>
      {audience.tone !== 'safe' && audience.tone !== 'off' && (
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {audience.plain}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button variant="outline" size="sm" onClick={handlePrimary}>
          {audience.primaryAction.label}
        </Button>
        {plugin.enabled && <PluginAudienceBadge tone={audience.tone} />}
        {plugin.errorCount > 0 && (
          <Badge variant="destructive">
            {t('plugins.errors', { count: plugin.errorCount })}
          </Badge>
        )}
      </div>
    </Card>
  )
}
