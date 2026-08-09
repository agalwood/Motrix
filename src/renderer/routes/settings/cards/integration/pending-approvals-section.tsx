import { Button } from '@renderer/components/ui/button'
import { useTranslation } from 'react-i18next'
import { usePendingPairRequests } from './use-bridge'

/** mm:ss remaining, floored at 0:00. */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Inbox of device-code (cli) requests awaiting approval. A derived view over
 * DeviceCodeService.pending: queries on mount, refetches on
 * bridge:pairRequested / bridge:paired and on window focus, and locally prunes
 * rows whose TTL lapses (see {@link usePendingPairRequests}). Lives in the CLI
 * section of the Integration card.
 */
export function PendingApprovalsSection() {
  const { t } = useTranslation()
  const { items, now, approve, deny } = usePendingPairRequests()

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-foreground">
        {t('settings.integration.cli.inbox.title')}{' '}
        <span className="text-muted-foreground">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <div className="rounded border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          {t('settings.integration.cli.inbox.empty')}
        </div>
      ) : (
        items.map((it) => (
          <div
            key={it.requestId}
            className="flex items-center justify-between rounded border border-border px-3 py-2 text-xs"
          >
            <div className="flex flex-col gap-0.5">
              <span className="font-mono">
                {it.clientName} · {it.clientVersion}
              </span>
              <span className="text-muted-foreground">
                {it.userCode} ·{' '}
                {t('settings.integration.cli.inbox.expiresIn', {
                  time: formatCountdown(it.expiresAt - now),
                })}
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                size="xs"
                onClick={() => void approve(it.requestId)}
              >
                {t('settings.integration.cli.inbox.approve')}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void deny(it.requestId)}
              >
                {t('settings.integration.cli.inbox.deny')}
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
