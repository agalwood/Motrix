import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseTaskBtTrackerResult {
  effective: string[]
  isLoading: boolean
  error: Error | null
  refresh: () => Promise<void>
}

export function useTaskBtTracker(
  engineGid: string | null
): UseTaskBtTrackerResult {
  const [effective, setEffective] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  // Monotonic token, not a shared cancel flag: the next effect run would
  // reset a boolean, letting a stale in-flight response for the previous
  // gid overwrite the current tracker list. Same guard as useTaskBtDetail.
  const requestIdRef = useRef(0)
  // The gid this hook is CURRENTLY keyed on. The token alone cannot stop a
  // stale `refresh` closure (captured across an await, then invoked after a
  // task switch): calling it would mint a NEWER token and commit the old
  // gid's trackers into the hook now rendering the new task.
  const currentGidRef = useRef(engineGid)

  const load = useCallback(async () => {
    if (engineGid !== currentGidRef.current) return
    const requestId = ++requestIdRef.current
    if (!engineGid) {
      setEffective([])
      setIsLoading(false)
      setError(null)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const data = (await transport.invoke(Queries.GetTaskBtTracker, {
        engineGid,
      })) as string[]
      if (requestIdRef.current === requestId) setEffective(data)
    } catch (e) {
      if (requestIdRef.current === requestId) {
        setError(e instanceof Error ? e : new Error(String(e)))
        setEffective([])
      }
    } finally {
      if (requestIdRef.current === requestId) setIsLoading(false)
    }
  }, [engineGid])

  useEffect(() => {
    if (currentGidRef.current !== engineGid) {
      currentGidRef.current = engineGid
      // Key changed: the previous task's list must not stay visible (or
      // writable) while the new gid's request is in flight — a fast detail
      // response would classify the stale rows as the new task's deletable
      // extras and open a cross-task overwrite path.
      setEffective([])
      setError(null)
    }
    load()
    return () => {
      requestIdRef.current += 1
    }
  }, [load, engineGid])

  return { effective, isLoading, error, refresh: load }
}
