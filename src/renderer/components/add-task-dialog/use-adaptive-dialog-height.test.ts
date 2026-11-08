import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampDialogHeight,
  useAdaptiveDialogHeight,
} from './use-adaptive-dialog-height'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('holds the expanded height during exit and resets for the next opening', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const dialog = document.createElement('div')
  dialog.innerHTML =
    '<header data-slot="dialog-header"></header><div data-adaptive-content></div><footer data-slot="add-task-form-footer"></footer>'
  Object.defineProperty(dialog.children[1], 'scrollHeight', { value: 600 })
  const ref = { current: dialog }
  const { result, rerender } = renderHook(
    ({ open }) =>
      useAdaptiveDialogHeight(ref, {
        collapsedHeight: 374,
        maxHeight: 760,
        open,
      }),
    { initialProps: { open: true } }
  )
  act(() => frames.pop()?.(0))
  expect(result.current.height).toBe(600)
  rerender({ open: false })
  expect(result.current.height).toBe(600)
  rerender({ open: true })
  expect(result.current.height).toBe(374)
})

describe('clampDialogHeight', () => {
  const base = {
    collapsedHeight: 374,
    maxHeight: 760,
    viewportHeight: 900,
    viewportPadding: 32,
  }

  it('keeps the collapsed dialog at its stable height', () => {
    expect(clampDialogHeight({ ...base, naturalHeight: 360 })).toBe(374)
  })

  it('grows to fit expanded content', () => {
    expect(clampDialogHeight({ ...base, naturalHeight: 612.8 })).toBe(612)
  })

  it('caps growth at both the product and viewport limits', () => {
    expect(clampDialogHeight({ ...base, naturalHeight: 900 })).toBe(760)
    expect(
      clampDialogHeight({
        ...base,
        naturalHeight: 900,
        viewportHeight: 720,
      })
    ).toBe(688)
  })

  it('fits short viewports even below the collapsed height', () => {
    expect(
      clampDialogHeight({
        ...base,
        naturalHeight: 600,
        viewportHeight: 320,
      })
    ).toBe(288)
  })
})
