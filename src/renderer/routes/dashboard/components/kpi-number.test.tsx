// src/renderer/routes/dashboard/components/kpi-number.test.tsx
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { KpiNumber } from './kpi-number'

describe('KpiNumber', () => {
  it('renders text content with tabular-nums and split unit sizing', () => {
    const { container } = render(<KpiNumber value="1.2 MB/s" />)
    const el = container.firstElementChild as HTMLElement
    expect(el).toHaveTextContent('1.2 MB/s')
    expect(el.className).toContain('tabular-nums')
    expect(screen.getByText('1.2').className).toContain('font-semibold')
    expect(screen.getByText('MB/s').className).toContain('text-[12px]')
  })

  it('uses the fixed secondary metric size under variant=compact', () => {
    const { container } = render(<KpiNumber value="9 KB/s" variant="compact" />)
    const el = container.firstElementChild as HTMLElement
    expect(el.className).toContain('text-[18px]')
  })

  it('inherits its font size when composed inside TileTitle', () => {
    const { container } = render(
      <KpiNumber value="99 MB/s" variant="inherit" />
    )
    const el = container.firstElementChild as HTMLElement

    expect(el.className).not.toContain('text-[')
    expect(el).toHaveClass('leading-none')
  })

  it('keeps long values shrink-safe while preserving the complete value', () => {
    const { container } = render(
      <KpiNumber value="12345678901234567890 MB/s" />
    )
    const el = container.firstElementChild as HTMLElement

    expect(el).toHaveAttribute('title', '12345678901234567890 MB/s')
    expect(el).toHaveClass('min-w-0', 'max-w-full')
    expect(screen.getByText('12345678901234567890')).toHaveClass(
      'min-w-0',
      'truncate'
    )
    expect(screen.getByText('MB/s')).toHaveClass('shrink-0')
  })

  it.each([
    { variant: 'inherit' as const, className: undefined },
    { variant: 'compact' as const, className: undefined },
    {
      variant: 'inherit' as const,
      className: 'text-[22px]',
    },
  ])(
    'keeps a tight line box for $variant with $className',
    ({ variant, className }) => {
      const { container } = render(
        <KpiNumber value="42 MB" variant={variant} className={className} />
      )
      const el = container.firstElementChild as HTMLElement

      expect(el).toHaveAttribute('data-slot', 'kpi-number')
      expect(el).toHaveClass('leading-none')
      expect(el).not.toHaveClass('leading-none!')
    }
  )
})
