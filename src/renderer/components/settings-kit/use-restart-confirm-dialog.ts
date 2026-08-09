import { useCallback, useRef, useState } from 'react'

export function useRestartConfirmDialog() {
  const [open, setOpen] = useState(false)
  const resolverRef = useRef<((v: boolean) => void) | null>(null)

  const confirm = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        resolverRef.current = resolve
        setOpen(true)
      }),
    []
  )

  const handleResolve = useCallback((confirmed: boolean) => {
    resolverRef.current?.(confirmed)
    resolverRef.current = null
    setOpen(false)
  }, [])

  return { confirm, open, handleResolve }
}
