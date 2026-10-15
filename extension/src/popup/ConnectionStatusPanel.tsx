import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { hasLoopbackPermission } from '@/background/mbp1/permission-gate'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { ConnectionDiagnosis } from '@/popup/ConnectionDiagnosis'
import type { PopupState } from '@/popup/usePopupState'
import { connectionErrorKey } from '@/shared/errorCopy'

interface Props {
  state: PopupState
  onReconnect: () => void
  onShowPairing?: () => void
  onNewTask?: () => void
  actionLabel?: string
}

/**
 * Seconds until a §7.3 backoff expires, ticking once a second while one is
 * active. `0` means "no backoff in force" — the tick stops then, so an idle
 * popup holds no timer.
 */
function useBackoffSecondsLeft(retryAtMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (retryAtMs === null || retryAtMs <= Date.now()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [retryAtMs])
  if (retryAtMs === null) return 0
  return Math.max(0, Math.ceil((retryAtMs - now) / 1000))
}

/** `hasLoopbackPermission()` is only a compatibility check today — `<all_urls>` is
 *  a required, install-time host permission that already covers the
 *  loopback origin — so this branch is currently unreachable in production.
 *  It remains wired so a future narrowing of `host_permissions` can add the
 *  corresponding optional permission flow without discovery failing silently. */
function usePermissionMissing(): boolean {
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let cancelled = false
    void hasLoopbackPermission().then((granted) => {
      if (!cancelled) setMissing(!granted)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return missing
}

const DOT_COLOR: Record<string, string> = {
  connected: 'bg-green-500',
  connecting: 'bg-amber-400 animate-pulse',
  bootstrapping: 'bg-amber-400 animate-pulse',
  handshaking: 'bg-amber-400 animate-pulse',
  'awaiting-code': 'bg-amber-400 animate-pulse',
  disconnected: 'bg-muted-foreground/50',
  denied: 'bg-red-500',
}

export function ConnectionStatusPanel({
  state,
  onReconnect,
  onShowPairing,
  onNewTask,
  actionLabel,
}: Props): React.ReactElement {
  const { t, i18n } = useTranslation()
  // Called unconditionally, before the loading early-return below — React's
  // rules of hooks don't bend for it.
  const permissionMissing = usePermissionMissing()
  const backoffSecondsLeft = useBackoffSecondsLeft(
    state.backoff?.retryAtMs ?? null
  )
  // A click must be visibly acknowledged at once — the attempt itself can
  // fail (e.g. under §7.3) faster than the 1 s state poll, which otherwise
  // leaves the UI pixel-identical and the click feeling dead. Cleared when
  // the next poll snapshot arrives (`state` is a fresh object every tick).
  const [pendingReconnect, setPendingReconnect] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies(state): the snapshot object itself is the signal — every poll delivers a fresh `state`, and its arrival is what acknowledges the click.
  useEffect(() => {
    setPendingReconnect(false)
  }, [state])

  if (state.loading || state.pairing === 'loading') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" aria-hidden="true" />
        {t('popup.loading')}
      </div>
    )
  }

  const conn = state.connection ?? 'disconnected'
  const isOk = conn === 'connected'
  const canShowPairing =
    state.pairingCode !== null && onShowPairing !== undefined

  const pairedIdle = state.pairing === 'stored' && conn === 'disconnected'
  const showError =
    state.lastError !== null &&
    (state.attemptIntent !== 'background-probe' || conn === 'denied')
  const showDiagnosis = showError
  const busy = [
    'bootstrapping',
    'connecting',
    'handshaking',
    'awaiting-code',
  ].includes(conn)
  const statusLabel =
    state.pairing === 'unavailable'
      ? t('popup.integration.pairingUnavailable')
      : state.phase === 'waking'
        ? t('popup.integration.waking')
        : pairedIdle
          ? t('popup.integration.pairedTitle')
          : conn === 'disconnected' && state.pairing === 'none'
            ? t('options.pairing.notPaired')
            : t(`popup.status.${conn}`, { defaultValue: conn })
  const errorKey = connectionErrorKey(state.lastErrorReason)
  const notices = (
    <>
      {/* §7.3: the retry time is always the client's own FirstPairBackoff
       *  value — bg.getState never forwards anything the peer reported. */}
      {state.backoff && (
        <Alert>
          <AlertTitle>{t('popup.pairing.backoffTitle')}</AlertTitle>
          <AlertDescription>
            {t('popup.pairing.backoffBody', {
              time: new Date(state.backoff.retryAtMs).toLocaleTimeString(
                i18n.resolvedLanguage
              ),
            })}
          </AlertDescription>
        </Alert>
      )}
      {permissionMissing && (
        <Alert>
          <AlertTitle>{t('popup.pairing.permissionMissingTitle')}</AlertTitle>
          <AlertDescription>
            {t('popup.pairing.permissionMissingBody')}
          </AlertDescription>
        </Alert>
      )}
      {/* Only shown while actually connected — this describes the live
       *  session's pairing, not an error condition. Not a warning about
       *  Motrix's authenticity: the pairing was still mutually
       *  authenticated by the code, only the host's own corroboration of
       *  *which* Motrix answered is missing. */}
      {isOk && state.degraded && (
        <Alert>
          <AlertTitle>{t('popup.pairing.degradedTitle')}</AlertTitle>
          <AlertDescription>{t('popup.pairing.degradedBody')}</AlertDescription>
        </Alert>
      )}
    </>
  )

  return (
    <Card className="h-full min-w-0 rounded-none border-0 py-0 shadow-none ring-0">
      <CardContent className="flex h-full min-h-0 flex-col gap-3 px-4 py-4 text-center">
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col gap-3',
            !showDiagnosis && 'overflow-y-auto overscroll-contain'
          )}
        >
          <div
            className={cn(
              'flex shrink-0 items-center justify-center gap-2',
              !showDiagnosis && 'mt-auto'
            )}
          >
            <span
              data-testid="status-dot"
              data-state={conn}
              className={cn(
                'h-2.5 w-2.5 rounded-full',
                showError
                  ? 'bg-connection-offline'
                  : pairedIdle
                    ? 'bg-connection-paired'
                    : (DOT_COLOR[conn] ?? 'bg-muted-foreground')
              )}
            />
            <span className="text-sm text-foreground">{statusLabel}</span>
          </div>
          {/* A reason never arrives without its message (they are set and
           *  suppressed together in bg.getState), so presence keys off the
           *  message alone; the reason picks the copy. */}
          {showError && (
            // Locale copy keyed by the stable reason code — the raw
            // `lastError` sentence is developer-facing (it also goes to
            // logs) and surfaces only as a hover title for diagnosis.
            <ConnectionDiagnosis
              key={JSON.stringify([
                state.lastError,
                state.lastErrorReason,
                state.endpoint,
              ])}
              state={state}
              heading={t('errors.connection.generic')}
              {...(errorKey !== 'errors.connection.generic'
                ? { description: t(errorKey) }
                : {})}
              variant="destructive"
            >
              {notices}
            </ConnectionDiagnosis>
          )}
          {!showDiagnosis && pairedIdle && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(
                state.endpoint?.activeEndpointId === 'local'
                  ? 'popup.integration.pairedBody'
                  : 'popup.integration.pairedRemoteBody'
              )}
            </p>
          )}
          {!showDiagnosis && (
            <>
              {notices}
              <div className="mb-auto" />
            </>
          )}
        </div>
        {!isOk && onNewTask && !busy && !showError && (
          <Button type="button" size="sm" onClick={onNewTask}>
            {t('popup.quickAdd.title')}
          </Button>
        )}
        {!isOk && (
          // §7.3: while the backoff is in force a click cannot succeed, so
          // the button says when it can instead of silently failing.
          <Button
            type="button"
            size="sm"
            className="shrink-0"
            variant={pairedIdle && !showError ? 'outline' : 'default'}
            disabled={
              actionLabel === undefined &&
              !canShowPairing &&
              (pendingReconnect || busy || backoffSecondsLeft > 0)
            }
            onClick={() => {
              if (canShowPairing) {
                onShowPairing()
                return
              }
              if (actionLabel !== undefined) {
                onReconnect()
                return
              }
              setPendingReconnect(true)
              onReconnect()
            }}
          >
            {!canShowPairing && pendingReconnect && (
              <Spinner data-icon="inline-start" />
            )}
            {canShowPairing
              ? t('popup.pairing.enterCode')
              : actionLabel !== undefined
                ? actionLabel
                : backoffSecondsLeft > 0
                  ? t('popup.pairing.retryIn', { seconds: backoffSecondsLeft })
                  : pairedIdle && !showError
                    ? t('popup.integration.viewTasks')
                    : state.pairing === 'none'
                      ? t('options.pairing.pair')
                      : t('popup.reconnect')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
