import { act, waitFor } from '@testing-library/react'
import { expect } from 'vitest'

/** Keep the real Base UI popup mounted while asserting its exit presentation. */
export function holdExitAnimation(popup: Element) {
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  Object.defineProperty(popup, 'getAnimations', {
    configurable: true,
    value: () => [{ finished }],
  })
  return async () => {
    await act(async () => finish())
    await waitFor(() => expect(popup.isConnected).toBe(false))
  }
}
