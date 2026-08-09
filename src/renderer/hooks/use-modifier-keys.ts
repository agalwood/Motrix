import { useEffect, useState } from 'react'

interface ModifierKeysState {
  shift: boolean
  alt: boolean
}

/**
 * Tracks whether Shift / Alt are currently held. Buttons that
 * change behavior with modifiers (Remove, Retry, Re-seed) read
 * this hook to swap their tooltip text in real time.
 */
export function useModifierKeys(): ModifierKeysState {
  const [keys, setKeys] = useState<ModifierKeysState>({
    shift: false,
    alt: false,
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      setKeys((prev) => {
        if (prev.shift === e.shiftKey && prev.alt === e.altKey) return prev
        return { shift: e.shiftKey, alt: e.altKey }
      })
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
  }, [])
  return keys
}
