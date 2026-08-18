import { describe, expect, it, vi } from 'vitest'
import { registerUpdateQuitPreparation } from './update-quit-preparation'

describe('registerUpdateQuitPreparation', () => {
  it('allows windows to close and bypasses confirmation before update quit', () => {
    let beforeQuitForUpdate: (() => void) | undefined
    const markForceQuit = vi.fn()
    const setWillQuit = vi.fn()
    const on = vi.fn((_event, listener: () => void) => {
      beforeQuitForUpdate = listener
    })

    registerUpdateQuitPreparation({
      updater: { on },
      markForceQuit,
      setWillQuit,
    })

    expect(on).toHaveBeenCalledExactlyOnceWith(
      'before-quit-for-update',
      expect.any(Function)
    )
    expect(markForceQuit).not.toHaveBeenCalled()
    expect(setWillQuit).not.toHaveBeenCalled()
    expect(beforeQuitForUpdate).toBeTypeOf('function')
    beforeQuitForUpdate?.()

    expect(markForceQuit).toHaveBeenCalledOnce()
    expect(setWillQuit).toHaveBeenCalledExactlyOnceWith(true)
  })
})
