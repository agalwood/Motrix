import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CubicGlassGradient } from './cubic-glass-gradient'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('CubicGlassGradient', () => {
  it('stays decorative and supports gradient presets', () => {
    const { container } = render(
      <CubicGlassGradient preset="blue-pink" className="test-class" />
    )
    const gradient = container.querySelector(
      '[data-slot="cubic-glass-gradient"]'
    )

    expect(gradient).toHaveAttribute('aria-hidden', 'true')
    expect(gradient).toHaveAttribute('data-preset', 'blue-pink')
    expect(gradient).toHaveAttribute('data-renderer', 'fallback')
    expect(gradient).toHaveAttribute('data-effect-load-fade', 'true')
    expect(gradient).toHaveAttribute('data-effect-breathing', 'true')
    expect(gradient).toHaveAttribute('data-effect-pointer-follow', 'true')
    expect(gradient).toHaveAttribute('data-effect-position-constraint', 'true')
    expect(gradient).toHaveAttribute('data-horizontal-speed', '50')
    expect(gradient).toHaveClass('test-class')
    expect(gradient?.tagName).toBe('DIV')
    expect(gradient?.querySelectorAll('canvas')).toHaveLength(1)
  })

  it('keeps the CSS fallback when WebGL2 is unavailable', () => {
    vi.stubGlobal('WebGL2RenderingContext', class {})
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(null)
    const { container } = render(<CubicGlassGradient />)

    expect(getContext).toHaveBeenCalledWith(
      'webgl2',
      expect.objectContaining({
        alpha: true,
        powerPreference: 'low-power',
        premultipliedAlpha: false,
      })
    )
    expect(
      container.querySelector('[data-slot="cubic-glass-gradient"]')
    ).toHaveAttribute('data-renderer', 'fallback')
  })

  it('updates the gradient preset without mounting another canvas', () => {
    const { container, rerender } = render(
      <CubicGlassGradient preset="blue-pink" />
    )
    rerender(<CubicGlassGradient preset="dual-wave" />)

    expect(
      container.querySelectorAll('[data-slot="cubic-glass-gradient"]')
    ).toHaveLength(1)
    expect(
      container.querySelector('[data-slot="cubic-glass-gradient"]')
    ).toHaveAttribute('data-preset', 'dual-wave')
  })

  it('resolves the master and individual effect switches without remounting', () => {
    const { container, rerender } = render(
      <CubicGlassGradient
        effects={{ enabled: false, breathing: true, pointerFollow: true }}
      />
    )
    const gradient = container.querySelector(
      '[data-slot="cubic-glass-gradient"]'
    )
    const canvas = gradient?.querySelector('canvas')

    expect(gradient).toHaveAttribute('data-effect-load-fade', 'false')
    expect(gradient).toHaveAttribute('data-effect-breathing', 'false')
    expect(gradient).toHaveAttribute('data-effect-pointer-follow', 'false')
    expect(gradient).toHaveAttribute('data-effect-position-constraint', 'false')

    rerender(
      <CubicGlassGradient
        effects={{ enabled: true, breathing: false, pointerFollow: true }}
      />
    )
    expect(gradient).toHaveAttribute('data-effect-load-fade', 'true')
    expect(gradient).toHaveAttribute('data-effect-breathing', 'false')
    expect(gradient).toHaveAttribute('data-effect-pointer-follow', 'true')
    expect(gradient).toHaveAttribute('data-effect-position-constraint', 'true')
    expect(gradient?.querySelector('canvas')).toBe(canvas)

    rerender(
      <CubicGlassGradient
        effects={{
          horizontalSpeed: 20,
          pointerFollow: true,
          positionConstraint: false,
        }}
      />
    )
    expect(gradient).toHaveAttribute('data-effect-pointer-follow', 'true')
    expect(gradient).toHaveAttribute('data-effect-position-constraint', 'false')
    expect(gradient).toHaveAttribute('data-horizontal-speed', '20')
    expect(gradient?.querySelector('canvas')).toBe(canvas)
  })
})
