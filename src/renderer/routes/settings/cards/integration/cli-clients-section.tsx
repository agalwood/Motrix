import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from '@renderer/components/ui/empty'
import type { PairedClientInfo } from '@shared/protocol/bridge'
import { useTranslation } from 'react-i18next'
import { usePairedExtensions } from './use-bridge'

/**
 * Lists remote cli/agent clients paired via the device-code flow (Spec 7b),
 * with revoke. A local CLI uses endpoint-file discovery and never appears
 * here.
 */
export function CLIClientsSection() {
  const { t } = useTranslation()
  const { items: paired, revoke } = usePairedExtensions()
  const clis = paired.filter(
    (p): p is Extract<PairedClientInfo, { kind: 'cli' }> => p.kind === 'cli'
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-foreground">
          {t('settings.integration.cli.remote.title')}{' '}
          <span className="text-muted-foreground">({clis.length})</span>
        </h4>
        <p className="text-xs text-muted-foreground">
          {t('settings.integration.cli.remote.description')}
        </p>
      </div>
      {clis.length === 0 ? (
        <Empty className="border p-4">
          <EmptyHeader>
            <EmptyDescription>
              {t('settings.integration.cli.remote.empty')}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        clis.map((it) => (
          <div
            key={it.id}
            className="flex items-center justify-between rounded border border-border px-3 py-2 text-xs"
          >
            <div className="flex flex-col gap-0.5">
              <span className="font-mono">{it.name || it.id}</span>
              <span className="text-muted-foreground">
                {it.lastActiveAt
                  ? `${t('settings.integration.cli.remote.lastActive')}: ${new Date(it.lastActiveAt).toLocaleString()}`
                  : t('settings.integration.cli.remote.neverActive')}
              </span>
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void revoke({ kind: 'cli', id: it.id })}
            >
              {t('settings.integration.cli.remote.revoke')}
            </Button>
          </div>
        ))
      )}
    </div>
  )
}
