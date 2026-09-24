import { useOperatorSession } from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function WebConnectionNotice() {
  const { t } = useTranslation()
  const session = useOperatorSession()
  const [connected, setConnected] = useState(
    () => transport.getConnectionState?.() === 'connected'
  )
  const [delayed, setDelayed] = useState(false)
  const authenticated = session.state === 'authenticated'
  const mismatch = session.status?.eventOriginMatches === false

  useEffect(() => {
    if (transport.platform !== 'web') return
    const stop = transport.onConnectionChange?.((event) => {
      setConnected(event.state === 'connected')
    })
    setConnected(transport.getConnectionState?.() === 'connected')
    return stop
  }, [])

  useEffect(() => {
    setDelayed(false)
    if (transport.platform !== 'web' || connected || !authenticated) return
    const timer = setTimeout(() => setDelayed(true), 5_000)
    return () => clearTimeout(timer)
  }, [connected, authenticated])

  if (
    transport.platform !== 'web' ||
    !authenticated ||
    connected ||
    (!delayed && !mismatch)
  )
    return null
  return (
    <div
      role="status"
      className="shrink-0 border-t border-border bg-muted px-4 py-2 text-xs text-muted-foreground"
    >
      <span className="font-medium text-foreground">
        {t(
          mismatch
            ? 'settings.connection.originMismatchTitle'
            : 'settings.connection.disconnectedTitle'
        )}
      </span>{' '}
      {t(
        mismatch
          ? 'settings.connection.originMismatchBody'
          : 'settings.connection.disconnectedBody'
      )}
    </div>
  )
}
