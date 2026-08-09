import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import type { ConsentPayload } from '@shared/types/plugin-install'
import { useTranslation } from 'react-i18next'
import { type GrantsMap, truncateOneLine } from '../lib/audience'
import { BroadHostAccessWarning } from './broad-host-access-warning'
import { ConsentDiffSection } from './consent-diff-section'
import { PermissionRow } from './permission-row'
import { PluginAudienceBadge } from './plugin-audience-badge'
import { PluginAvatar } from './plugin-avatar'

interface Props {
  consent: ConsentPayload
  grants: GrantsMap
  onGrantsChange: (next: GrantsMap) => void
}

export function InlineConsentPanel({ consent, grants, onGrantsChange }: Props) {
  const { t } = useTranslation()
  const isBroadHost = consent.trustSurface.hostPermissions.some((h) => h.broad)
  return (
    <div className="mt-4 space-y-3">
      <div className="grid grid-cols-[44px_1fr_auto] items-center gap-3 rounded-lg border bg-card p-3">
        <PluginAvatar plugin={consent.manifest} size={44} />
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium">
            {consent.manifest.name}
          </h3>
          <p className="truncate text-xs leading-5 text-muted-foreground">
            {truncateOneLine(consent.manifest.description, 120)}
          </p>
        </div>
        <PluginAudienceBadge tone={isBroadHost ? 'review' : 'safe'} />
      </div>

      <div className="grid gap-2">
        {consent.trustSurface.permissions.map((p) => (
          <PermissionRow key={p.name} permission={p.name} granted={true} />
        ))}
        {consent.trustSurface.optionalPermissions.map((p) => (
          <PermissionRow
            key={p.name}
            permission={p.name}
            granted={grants[p.name] === 'granted'}
            onToggle={() => {
              const next = { ...grants }
              next[p.name] = next[p.name] === 'granted' ? 'denied' : 'granted'
              onGrantsChange(next)
            }}
          />
        ))}
      </div>

      {isBroadHost && <BroadHostAccessWarning />}

      {consent.diff && <ConsentDiffSection diff={consent.diff} />}

      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-5">
        <strong className="text-amber-700">
          {t('plugins.install.warning')}
        </strong>
      </div>

      <Collapsible className="border-t pt-3">
        <CollapsibleTrigger className="text-xs font-medium text-muted-foreground">
          {t('plugins.card.advancedDetails')}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
            <code>source type: {consent.source.type}</code>
            <code>plugin id: {consent.manifest.id}</code>
            {consent.trustSurface.hostPermissions.map((h) => (
              <code key={h.pattern}>host: {h.pattern}</code>
            ))}
            <code>bundle type: .moext</code>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
