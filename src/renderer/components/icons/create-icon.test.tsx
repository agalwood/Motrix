import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { LucideProvider } from 'lucide-react'
import { createRef, forwardRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createIcon, type MotrixIconProps } from './create-icon'
import { DownloadIcon } from './download'
import { SpeedAutoIcon } from './speed-auto'

afterEach(cleanup)

describe('Motrix Lucide icons', () => {
  it('keeps the Lucide drawing and stroke when displayed at a compact size', () => {
    const { container } = render(
      <SpeedAutoIcon size={12} style={{ width: 12, height: 12 }} />
    )
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24')
    expect(svg).toHaveAttribute('width', '12')
    expect(svg).toHaveAttribute('stroke-width', '2')
    expect(svg).toHaveClass('lucide-squirrel', 'motrix-icon')
    expect(svg).toHaveAttribute('data-icon', 'speed-auto')
    expect(svg).toHaveAttribute('data-icon-set', 'lucide')
  })

  it('preserves Lucide provider defaults and caller overrides', () => {
    const { container, rerender } = render(
      <LucideProvider size={20} color="red" strokeWidth={1.5}>
        <DownloadIcon />
      </LucideProvider>
    )
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('width', '20')
    expect(svg).toHaveAttribute('stroke', 'red')
    expect(svg).toHaveAttribute('stroke-width', '1.5')

    rerender(
      <LucideProvider size={20} color="red" strokeWidth={1.5}>
        <DownloadIcon
          size={16}
          color="currentColor"
          strokeWidth={1.75}
          focusable="false"
          data-icon="inline-start"
        />
      </LucideProvider>
    )
    expect(svg).toHaveAttribute('width', '16')
    expect(svg).toHaveAttribute('stroke', 'currentColor')
    expect(svg).toHaveAttribute('stroke-width', '1.75')
    expect(svg).toHaveAttribute('data-icon', 'inline-start')
    expect(svg).toHaveAttribute('focusable', 'false')
  })

  it('accepts a custom SVG glyph without a Lucide contract', () => {
    const Glyph = forwardRef<SVGSVGElement, MotrixIconProps>(function Glyph(
      { size = 24, ...props },
      ref
    ) {
      return (
        // biome-ignore lint/a11y/noSvgWithoutTitle: The icon wrapper supplies the accessible name.
        <svg
          ref={ref}
          width={size}
          height={size}
          viewBox="0 0 20 20"
          fill="currentColor"
          {...props}
        >
          <circle cx="10" cy="10" r="6" />
          {props.children}
        </svg>
      )
    })
    const CustomIcon = createIcon('status-dot', Glyph, 'custom')
    const ref = createRef<SVGSVGElement>()
    render(<CustomIcon ref={ref} size={16} title="Custom status" />)
    expect(screen.getByRole('img', { name: 'Custom status' })).toBe(ref.current)
    expect(ref.current).toHaveAttribute('viewBox', '0 0 20 20')
    expect(ref.current).toHaveAttribute('width', '16')
    expect(ref.current).toHaveAttribute('data-icon', 'status-dot')
    expect(ref.current).toHaveAttribute('data-icon-set', 'custom')
    expect(ref.current).toHaveAttribute('fill', 'currentColor')
    expect(ref.current).not.toHaveClass('lucide')
  })

  it('exposes translated titles and forwards refs and SVG attributes', () => {
    const ref = createRef<SVGSVGElement>()
    render(
      <DownloadIcon
        ref={ref}
        title="Download"
        size={20}
        data-testid="download-icon"
        className="animate-spin"
      />
    )
    expect(screen.getByRole('img', { name: 'Download' })).toBe(ref.current)
    expect(ref.current).toHaveAttribute('viewBox', '0 0 24 24')
    expect(ref.current).toHaveAttribute('width', '20')
    expect(ref.current).toHaveClass('animate-spin', 'motrix-icon', 'lucide')
    expect(ref.current).not.toHaveAttribute('aria-hidden')
  })

  it('hides decorative symbols and accepts explicit accessible labels', () => {
    const { rerender } = render(<DownloadIcon data-testid="icon" />)
    expect(screen.getByTestId('icon')).toHaveAttribute('aria-hidden', 'true')
    rerender(<DownloadIcon aria-label="Download" />)
    expect(screen.getByRole('img', { name: 'Download' })).not.toHaveAttribute(
      'aria-hidden'
    )
    rerender(
      <>
        <span id="download-label">Download file</span>
        <DownloadIcon aria-labelledby="download-label" />
      </>
    )
    expect(
      screen.getByRole('img', { name: 'Download file' })
    ).not.toHaveAttribute('aria-hidden')
  })
})
