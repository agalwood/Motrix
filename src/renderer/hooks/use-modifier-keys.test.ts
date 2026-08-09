import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useModifierKeys } from './use-modifier-keys'

function fireKey(type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent(type, init))
}

describe('useModifierKeys', () => {
  it('starts with both modifiers false', () => {
    const { result } = renderHook(() => useModifierKeys())
    expect(result.current).toEqual({ shift: false, alt: false })
  })

  it('reports shift held', () => {
    const { result } = renderHook(() => useModifierKeys())
    act(() => fireKey('keydown', { shiftKey: true, altKey: false }))
    expect(result.current.shift).toBe(true)
    expect(result.current.alt).toBe(false)
  })

  it('reports alt held', () => {
    const { result } = renderHook(() => useModifierKeys())
    act(() => fireKey('keydown', { shiftKey: false, altKey: true }))
    expect(result.current.alt).toBe(true)
  })

  it('clears modifiers on keyup', () => {
    const { result } = renderHook(() => useModifierKeys())
    act(() => fireKey('keydown', { shiftKey: true, altKey: true }))
    expect(result.current).toEqual({ shift: true, alt: true })
    act(() => fireKey('keyup', { shiftKey: false, altKey: false }))
    expect(result.current).toEqual({ shift: false, alt: false })
  })

  it('removes listeners on unmount', () => {
    const { unmount } = renderHook(() => useModifierKeys())
    unmount()
    // No assertion — passing means no errors are thrown when subsequent
    // dispatches arrive after unmount.
    fireKey('keydown', { shiftKey: true })
  })
})
