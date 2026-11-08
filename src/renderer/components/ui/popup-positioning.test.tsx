import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { PopupTopInsetContext, usePopupPositioning } from './popup-positioning'

const wrapper = ({ children }: { children: ReactNode }) => (
  <PopupTopInsetContext.Provider value={54}>
    {children}
  </PopupTopInsetContext.Provider>
)

describe('popup positioning', () => {
  it('preserves the library defaults outside native chrome', () => {
    const { result } = renderHook(() => usePopupPositioning())
    expect(result.current).toEqual({ collisionPadding: undefined })
  })

  it('preserves explicit padding without a reserved band', () => {
    const padding = { top: 80, left: 10 }
    const { result } = renderHook(() => usePopupPositioning(padding))
    expect(result.current.collisionPadding).toBe(padding)
    expect(result.current).not.toHaveProperty('sticky')
  })

  it('applies the native minimum without losing caller edge padding', () => {
    const { result } = renderHook(() => usePopupPositioning(12), { wrapper })
    expect(result.current).toEqual({
      collisionPadding: { top: 54, right: 12, bottom: 12, left: 12 },
      sticky: true,
    })
  })

  it('keeps larger caller top padding and defaults omitted edges', () => {
    const { result } = renderHook(
      () => usePopupPositioning({ top: 80, left: 0 }),
      { wrapper }
    )
    expect(result.current.collisionPadding).toEqual({
      top: 80,
      right: 5,
      bottom: 5,
      left: 0,
    })
  })
})
