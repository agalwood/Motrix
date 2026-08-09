import type { PluginManifestDTO } from '@shared/types/plugin'
import { useTranslation } from 'react-i18next'
import { type GrantsMap, isBroadHostAccess } from '../lib/audience'
import { BroadHostAccessWarning } from './broad-host-access-warning'
import { PermissionRow } from './permission-row'

interface Props {
  manifest: Pick<
    PluginManifestDTO,
    'permissions' | 'optionalPermissions' | 'hostPermissions'
  >
  grants: GrantsMap
  onToggleGrant?: (permission: string) => void
  /**
   * Builtin / dev plugins are trusted by construction: the host grants them
   * every declared permission (GrantsManager.effectivePermissionsFor) and
   * rejects grant mutations (updateGrants → plugin.grants.not_supported). So
   * their optional permissions render as read-only "granted" with no toggle —
   * never wire an interactive switch that would throw on click.
   */
  trusted?: boolean
}

export function AccessSection({
  manifest,
  grants,
  onToggleGrant,
  trusted = false,
}: Props) {
  const { t } = useTranslation()
  const optional = manifest.optionalPermissions ?? []
  const broad = isBroadHostAccess(manifest.hostPermissions)
  return (
    <div className="w-full space-y-4 rounded-lg border bg-card shadow-none p-4">
      {manifest.permissions.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold">
            {t('plugins.detail.accessGranted')}
          </h4>
          <div className="mt-2 space-y-2">
            {manifest.permissions.map((p) => (
              <PermissionRow key={p} permission={p} granted={true} />
            ))}
          </div>
        </section>
      )}

      {optional.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold">
            {t('plugins.detail.accessOptional')}
          </h4>
          <div className="mt-2 space-y-2">
            {optional.map((p) => (
              <PermissionRow
                key={p}
                permission={p}
                granted={trusted || grants[p] === 'granted'}
                onToggle={
                  !trusted && onToggleGrant ? () => onToggleGrant(p) : undefined
                }
              />
            ))}
          </div>
        </section>
      )}

      {broad && <BroadHostAccessWarning />}
    </div>
  )
}
