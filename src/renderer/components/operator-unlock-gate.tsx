import { Button } from '@renderer/components/ui/button'
import { getOperatorStatus, operatorLogin } from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Gates the app on the server (web) build behind operator authentication
 * (Spec 9). The desktop build talks to the core over IPC and never hits `/rpc`,
 * so the gate is a pass-through there.
 */
export function OperatorUnlockGate({ children }: { children: ReactNode }) {
  if (transport.platform !== 'web') return <>{children}</>
  return <WebGate>{children}</WebGate>
}

type GateState = 'checking' | 'locked' | 'unlocked'

function WebGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [state, setState] = useState<GateState>('checking')
  const [token, setToken] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getOperatorStatus().then((ok) => {
      if (!cancelled) setState(ok ? 'unlocked' : 'locked')
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (state === 'checking') return null
  if (state === 'unlocked') return <>{children}</>

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!token.trim() || busy) return
    setBusy(true)
    setError(false)
    const ok = await operatorLogin(token.trim())
    setBusy(false)
    if (ok) setState('unlocked')
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
