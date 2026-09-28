import { Button } from '@renderer/components/ui/button'
import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import type { AppSettings } from '@shared/types/settings'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** Drafts cannot be edited or saved until their authoritative baseline loads. */
export function useSettingsLoad(onLoad: (settings: AppSettings) => void) {
  const callback = useRef(onLoad)
  callback.current = onLoad
  const [state, setState] = useState({ ready: false, error: false })
  const generation = useRef(0)
  const retry = useCallback(async () => {
    const revision = ++generation.current
    setState({ ready: false, error: false })
    try {
      const settings = (await transport.invoke(
        Queries.GetSettings
      )) as AppSettings
      if (revision !== generation.current) return
      if (!settings || typeof settings !== 'object')
        throw new Error('Missing settings snapshot')
      callback.current(settings)
      setState({ ready: true, error: false })
    } catch {
      if (revision === generation.current)
        setState({ ready: false, error: true })
    }
  }, [])
  useEffect(() => {
    void retry()
    return () => {
      generation.current++
    }
  }, [retry])
  return { ...state, retry }
}

export function SettingsLoadStatus({
  ready,
  error,
  retry,
}: ReturnType<typeof useSettingsLoad>) {
  const { t } = useTranslation()
  if (ready) return null
  return (
    <div
      className="flex items-center justify-between gap-4 text-xs text-muted-foreground"
      role={error ? 'alert' : 'status'}
    >
      <p>{t(error ? 'settings.validation.loadFailed' : 'common.loading')}</p>
      {error && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void retry()}
        >
          {t('common.retry')}
        </Button>
      )}
    </div>
  )
}
