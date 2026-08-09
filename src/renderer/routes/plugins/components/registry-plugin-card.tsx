import { Badge } from '@renderer/components/ui/badge'
import { Card } from '@renderer/components/ui/card'
import type { RegistryPluginDTO } from '@shared/schemas/registry'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { registryListing } from '../lib/registry-text'
import { PluginAvatar } from './plugin-avatar'

interface Props {
  entry: RegistryPluginDTO
}

/**
 * Directory card for a registry plugin that is not installed. Clicking
 * opens the registry-backed detail view; installing is never triggered
 * from here (navigation-only, .claude/rules/plugin-registry.md).
 */
export function RegistryPluginCard({ entry }: Props) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { name, description } = registryListing(entry.listing, i18n.language)

  return (
    <Card
      role="button"
      tabIndex={0}
      data-testid={`registry-card-${entry.id}`}
      className="flex cursor-pointer flex-col gap-2.5 p-4 transition-colors hover:bg-muted/40"
      onClick={() => navigate(`/plugins/${entry.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          navigate(`/plugins/${entry.id}`)
        }
      }}
    >
      <div className="flex items-start gap-3">
        <PluginAvatar plugin={{ id: entry.id, name, icon: entry.icon }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold tracking-tight">
              {name}
            </h3>
            {entry.featured && (
              <Badge variant="secondary">
                {t('plugins.registry.featured')}
              </Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {t('plugins.registry.byAuthor', { name: entry.author.name })}
            {' · '}v{entry.version}
          </p>
        </div>
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">
        {description}
      </p>
      {!entry.compatible && (
        <Badge variant="outline" className="w-fit text-muted-foreground">
          {t('plugins.registry.requires', { range: entry.engines.motrix })}
        </Badge>
      )}
    </Card>
  )
}
