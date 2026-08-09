import { Alert } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import type { PluginListDTO, PluginManifestDTO } from '@shared/types/plugin'
import { useTranslation } from 'react-i18next'
import {
  computePluginAudience,
  summarizeAccess,
  summarizeHealth,
  truncateOneLine,
} from '../lib/audience'
import { PluginAvatar } from './plugin-avatar'

interface Props {
  plugin: PluginListDTO
  manifest: PluginManifestDTO
  onJumpToLogs: () => void
}

function MiniCard({ strong, value }: { strong: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <strong className="text-[11px] font-medium uppercase text-muted-foreground">
        {strong}
      </strong>
      <p className="mt-1 text-sm leading-5">{value}</p>
    </div>
  )
}

export function OverviewSection({ plugin, manifest, onJumpToLogs }: Props) {
  const { t } = useTranslation()
  const audience = computePluginAudience(
    plugin,
    manifest.hostPermissions,
    t,
    undefined,
    Boolean(manifest.contributes.configuration?.schema)
  )
  return (
    <div className="w-full space-y-4">
      <div className="rounded-lg border bg-card p-4 shadow-none space-y-2">
        <div className="grid grid-cols-[54px_1fr] items-start gap-3">
          <PluginAvatar plugin={manifest} size={54} />
          <div>
            <h3 className="text-base font-semibold">{manifest.name}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              v{manifest.version} · {manifest.id}
            </p>
          </div>
        </div>
        <p className="text-sm">{manifest.description}</p>
        {manifest.author && (
          <div className="grid gap-1 text-sm sm:grid-cols-[120px_1fr]">
            <span className="text-muted-foreground">
              {t('plugins.detail.author')}
            </span>
            <span>{manifest.author}</span>
          </div>
        )}
        {manifest.homepage && (
          <div className="grid gap-1 text-sm sm:grid-cols-[120px_1fr]">
            <span className="text-muted-foreground">
              {t('plugins.detail.homepage')}
            </span>
            <a
              className="w-fit underline underline-offset-4"
              href={manifest.homepage}
              target="_blank"
              rel="noreferrer"
            >
              {manifest.homepage}
            </a>
          </div>
        )}
        <h3 className="mt-6 text-base font-medium tracking-tight">
          {audience.heroHeadline}
        </h3>
        <p className="text-sm leading-none text-muted-foreground">
          {audience.plain}
        </p>
        <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <MiniCard
            strong={t('plugins.detail.mini.purpose')}
            value={truncateOneLine(manifest.description, 60)}
          />
          <MiniCard
            strong={t('plugins.detail.mini.access')}
            value={summarizeAccess(manifest.hostPermissions, t)}
          />
          <MiniCard
            strong={t('plugins.detail.mini.health')}
            value={summarizeHealth(plugin, t)}
          />
        </div>
      </div>

      {plugin.errorCount > 0 && (
        <Alert variant="destructive">
          <div className="flex-1">
            <div className="text-sm font-semibold">
              {t('plugins.detail.attentionTitle')}
            </div>
            <div className="mt-0.5 text-xs">
              {plugin.lastError ?? t('plugins.detail.attentionGeneric')}
            </div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={onJumpToLogs}>
                {t('plugins.detail.viewIssue')}
              </Button>
            </div>
          </div>
        </Alert>
      )}
    </div>
  )
}
