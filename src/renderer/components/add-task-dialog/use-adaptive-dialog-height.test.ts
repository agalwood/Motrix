import { describe, expect, it } from 'vitest'
import { clampDialogHeight } from './use-adaptive-dialog-height'

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
