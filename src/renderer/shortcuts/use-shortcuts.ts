import { DEFAULT_KEYBINDINGS } from '@shared/keybindings-catalog'
import { useEffect } from 'react'
import { executeCommand } from './executor'
import { isTyping, matchesAccelerator } from './match'

export function useShortcuts(): void {
  useEffect(() => {
    if (__MOTRIX_TARGET__ === 'electron') return

    const bindings = DEFAULT_KEYBINDINGS.filter(
      (k) => k.webAccelerator !== null
    ).map((k) => ({
      commandId: k.commandId,
      accelerator: k.webAccelerator ?? k.accelerator,
    }))

    const handler = (e: KeyboardEvent): void => {
      if (isTyping(e.target)) return
      for (const b of bindings) {
        if (matchesAccelerator(e, b.accelerator)) {
          e.preventDefault()
          void executeCommand(b.commandId)
          return
        }
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])
}
