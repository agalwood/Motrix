import { Badge } from '@renderer/components/ui/badge'
import type { GrantsMap } from '@shared/types/plugin-install'
import { useTranslation } from 'react-i18next'

export function PluginPermissionList({
  permissions,
  optionalPermissions,
  grants,
}: {
  permissions: ReadonlyArray<string>
  optionalPermissions: ReadonlyArray<string>
  grants: GrantsMap
}) {
  const { t } = useTranslation()

  if (permissions.length === 0 && optionalPermissions.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        {t('plugins.permissions.empty')}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {permissions.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold">
            {t('plugins.consent.permissions')}
          </h4>
          <ul className="mt-1 space-y-1 text-xs">
            {permissions.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {optionalPermissions.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold">
            {t('plugins.consent.optionalPermissions')}
          </h4>
          <ul className="mt-1 space-y-1 text-xs">
            {optionalPermissions.map((p) => (
              <li key={p} className="flex items-center gap-2">
                <code>{p}</code>
                {grants[p] === 'granted' ? (
                  <Badge variant="default">
                    {t('plugins.permissions.granted')}
                  </Badge>
                ) : (
                  <Badge variant="outline">
                    {t('plugins.permissions.denied')}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
