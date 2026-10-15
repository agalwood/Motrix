import { useCallback, useEffect, useRef, useState } from 'react'
import { send } from '@/background/MessageBus'

/** Check on each enable attempt so pairing in another page is immediately usable. */
export function useTakeoverPairing() {
  const [required, setRequired] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState(false)
  const mounted = useRef(true)
  const pending = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const check = useCallback(async (): Promise<boolean> => {
    if (pending.current) return false
    pending.current = true
    setChecking(true)
    setError(false)
    try {
      const result = await send('bg.hasPairedBackend', undefined)
      if (!mounted.current) return false
      setRequired(!result.paired)
      return result.paired
    } catch {
      if (mounted.current) setError(true)
      return false
    } finally {
      pending.current = false
      if (mounted.current) setChecking(false)
    }
  }, [])
  const cancel = useCallback(() => setRequired(false), [])
  return { required, checking, error, check, cancel }
}
