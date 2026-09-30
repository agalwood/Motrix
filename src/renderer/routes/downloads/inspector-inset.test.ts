import { describe, expect, it } from 'vitest'
import { resolveInspectorInset } from './inspector-inset'

const FOOTER = 48
const HEADER = 80

describe('resolveInspectorInset', () => {
  it('returns 0 when the inspector is closed', () => {
    expect(
      resolveInspectorInset({
        pageHeight: 800,
        footerHeight: FOOTER,
        gridHeight: 800 - HEADER - FOOTER,
        snap: 'medium',
        open: false,
      })
    ).toBe(0)
  })

  it('returns 0 before the page has been measured', () => {
    expect(
      resolveInspectorInset({
        pageHeight: 0,
        footerHeight: 0,
        gridHeight: 0,
        snap: 'medium',
        open: true,
      })
    ).toBe(0)
  })

  it('compensates the overlap above the overlaid footer for each snap', () => {
    const base = {
      pageHeight: 800,
      footerHeight: FOOTER,
      gridHeight: 800 - HEADER - FOOTER,
      open: true,
    }
    // getInspectorSnapHeights(800) resolves to [220, 400, 600].
    expect(resolveInspectorInset({ ...base, snap: 'compact' })).toBe(
      220 - FOOTER
    )
    expect(resolveInspectorInset({ ...base, snap: 'medium' })).toBe(
      400 - FOOTER
    )
    expect(resolveInspectorInset({ ...base, snap: 'expanded' })).toBe(
      600 - FOOTER
    )
  })

  it('ignores a drawer that does not reach past the footer', () => {
    expect(
      resolveInspectorInset({
        pageHeight: 96,
        footerHeight: FOOTER,
        gridHeight: 10,
        snap: 'compact',
        open: true,
      })
    ).toBe(0)
  })

  it('never scrolls the last row out of the grid on short pages', () => {
    // On a 200px page every snap merges at 136px; the 72px grid leaves no
    // room once the header and one row are excluded.
    expect(
      resolveInspectorInset({
        pageHeight: 200,
        footerHeight: FOOTER,
        gridHeight: 200 - HEADER - FOOTER,
        snap: 'medium',
        open: true,
      })
    ).toBe(0)
  })

  it('caps compensation so the last row stays reachable', () => {
    // Expanded on a 300px page: maximum is 225px, overlap 177px, but the
    // 172px grid only offsets rows by 100px before they leave the top.
    expect(
      resolveInspectorInset({
        pageHeight: 300,
        footerHeight: FOOTER,
        gridHeight: 300 - HEADER - FOOTER,
        snap: 'expanded',
        open: true,
      })
    ).toBe(300 - HEADER - FOOTER - 36 - 36)
  })
})
