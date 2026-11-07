import { Button } from '@renderer/components/ui/button'
import {
  operatorLogin,
  refreshOperatorSession,
  useOperatorSession,
  watchOperatorSession,
} from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { isNasAuthMode } from '@shared/schemas/operator-auth'
import {
  type FormEvent,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

const StorageRecovery =
  __MOTRIX_TARGET__ === 'web'
    ? lazy(() =>
        import('./nas-storage-recovery').then((module) => ({
          default: module.NasStorageRecovery,
        }))
      )
    : () => null

/**
 * Gates the app on the server (web) build behind operator authentication
 * (Spec 9). The desktop build talks to the core over IPC and never hits `/rpc`,
 * so the gate is a pass-through there.
 */
export function OperatorUnlockGate({ children }: { children: ReactNode }) {
  if (transport.platform !== 'web') return <>{children}</>
  return <WebGate>{children}</WebGate>
}

function WebGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const state = useOperatorSession((s) => s.state)
  const fnos = useOperatorSession((s) => isNasAuthMode(s.status?.mode))
  const synology = useOperatorSession((s) => s.status?.mode === 'synologyDsm')
  const diagnostic = useOperatorSession((s) => s.status?.nasAuthDiagnostic)
  const unavailableRoots = useOperatorSession(
    (s) => s.status?.nasUnavailableDownloadRoots
  )
  const [token, setToken] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refreshOperatorSession()
    return watchOperatorSession()
  }, [])

  if (state === 'checking') return null
  if (state === 'unavailable')
    return (
      <div className="flex h-svh flex-col items-center justify-center gap-4">
        <p>{t('applicationMenu.serverUnavailable')}</p>
        <Button onClick={() => void refreshOperatorSession()}>
          {t('applicationMenu.retry')}
        </Button>
      </div>
    )
  if (state === 'authenticated' && synology && unavailableRoots?.length)
    return (
      <Suspense fallback={null}>
        <StorageRecovery roots={unavailableRoots} />
      </Suspense>
    )
  if (state === 'authenticated' || state === 'logging-out')
    return <>{children}</>
  if (fnos)
    return (
      <div className="flex h-svh flex-col items-center justify-center gap-4 p-6">
        <p>{t('operatorUnlock.nasSessionExpired')}</p>
        {diagnostic && (
          <code className="select-text text-xs text-muted-foreground">
            {[
              diagnostic.stage,
              diagnostic.code,
              diagnostic.failure,
              diagnostic.exitCode,
            ]
              .filter((value) => value !== undefined)
              .join(' / ')}
          </code>
        )}
        <Button onClick={() => window.location.reload()}>
          {t('applicationMenu.retry')}
        </Button>
        {synology && (
          <Button variant="outline" onClick={() => window.location.assign('/')}>
            {t('operatorUnlock.openDsm')}
          </Button>
        )}
      </div>
    )

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!token.trim() || busy) return
    setBusy(true)
    setError(false)
    const ok = await operatorLogin(token.trim())
    setBusy(false)
    if (ok) setToken('')
    else setError(true)
  }

  return (
    <div className="flex h-svh items-center justify-center bg-background p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border p-6"
      >
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">
            {t('operatorUnlock.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('operatorUnlock.help')}
          </p>
        </div>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t('operatorUnlock.placeholder')}
          autoComplete="off"
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {error && (
          <p className="text-sm text-destructive">
            {t('operatorUnlock.error')}
          </p>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={busy || !token.trim()}
        >
          {t('operatorUnlock.submit')}
        </Button>
      </form>
    </div>
  )
}
