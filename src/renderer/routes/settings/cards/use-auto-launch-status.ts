import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  type AutoLaunchStatus,
  AutoLaunchStatusSchema,
  OpenStartupSettingsResultSchema,
} from '@shared/schemas/auto-launch'
import { useCallback, useEffect, useRef, useState } from 'react'

/** A read-only view of Windows authority, independent of the saved preference. */
export function useAutoLaunchStatus(active: boolean) {
  const [status, setStatus] = useState<AutoLaunchStatus | null>(null)
  const [loading, setLoading] = useState(active)
  const [openFailed, setOpenFailed] = useState(false)
  const generation = useRef(0)
  const mounted = useRef(false)
  const refresh = useCallback(async () => {
    if (!active) return
    const current = ++generation.current
    setLoading(true)
    try {
      const next = AutoLaunchStatusSchema.parse(
        await transport.invoke(Queries.GetAutoLaunchStatus)
      )
      if (mounted.current && current === generation.current) setStatus(next)
    } catch {
      if (mounted.current && current === generation.current) setStatus(null)
    } finally {
      if (mounted.current && current === generation.current) setLoading(false)
    }
  }, [active])
  useEffect(() => {
    mounted.current = true
    void refresh()
    const onFocus = () => void refresh()
    if (active) window.addEventListener('focus', onFocus)
    return () => {
      mounted.current = false
      generation.current++
      window.removeEventListener('focus', onFocus)
    }
  }, [active, refresh])

  const openSettings = async () => {
    setOpenFailed(false)
    try {
      const result = OpenStartupSettingsResultSchema.parse(
        await transport.invoke(Commands.OpenStartupSettings)
      )
      if (mounted.current && !result.ok) setOpenFailed(true)
    } catch {
      if (mounted.current) setOpenFailed(true)
    }
  }
  return { status, loading, refresh, openSettings, openFailed }
}
