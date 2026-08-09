import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useRestartConfirmDialog } from './use-restart-confirm-dialog'

describe('useRestartConfirmDialog', () => {
  it('opens on confirm() and resolves true on handleResolve(true)', async () => {
    const { result } = renderHook(() => useRestartConfirmDialog())
    expect(result.current.open).toBe(false)

    let promise!: Promise<boolean>
    act(() => {
      promise = result.current.confirm()
    })
    expect(result.current.open).toBe(true)

    act(() => {
      result.current.handleResolve(true)
    })
    await expect(promise).resolves.toBe(true)
    expect(result.current.open).toBe(false)
  })

  it('resolves false on handleResolve(false)', async () => {
    const { result } = renderHook(() => useRestartConfirmDialog())
    let promise!: Promise<boolean>
    act(() => {
      promise = result.current.confirm()
    })
    act(() => {
      result.current.handleResolve(false)
    })
    await expect(promise).resolves.toBe(false)
  })
})
