import { useLayoutEffect, useRef } from 'react'

/** Preserve presentation during exit; actions must still use the live state. */
export function useExitSnapshot<T>(open: boolean, value: T): T {
  const snapshot = useRef(value)
  useLayoutEffect(() => {
    if (open) snapshot.current = value
  }, [open, value])
  return open ? value : snapshot.current
}
