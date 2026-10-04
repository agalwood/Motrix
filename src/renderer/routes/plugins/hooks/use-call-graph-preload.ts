import { usePlatformServices } from '@renderer/platform/services'
import { useCallback, useEffect } from 'react'
import { preloadCallGraphLayout } from '../lib/call-graph-layout'

export function useCallGraphPreload(): () => void {
  const { kind } = usePlatformServices()
  const preload = useCallback(() => {
    if (kind === 'electron' && document.visibilityState === 'visible') {
      void preloadCallGraphLayout()
    }
  }, [kind])

  useEffect(() => {
    if (kind !== 'electron') return
    let idle: number | undefined
    // Let the plugin page paint before spending idle time on its diagnostics.
    const timer = window.setTimeout(() => {
      idle = window.requestIdleCallback(preload, { timeout: 1500 })
    }, 200)
    return () => {
      window.clearTimeout(timer)
      if (idle !== undefined) window.cancelIdleCallback(idle)
    }
  }, [kind, preload])

  return preload
}
