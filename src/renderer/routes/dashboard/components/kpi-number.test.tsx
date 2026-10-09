import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { KpiNumber } from './kpi-number'

describe('KpiNumber', () => {
  it.each([
    ['1,50', 'Mio'],
    ['1,5', 'МиБ/с'],
    ['١٫٥', 'MiB/ث'],
    ['۱٫۵', 'MiB/ثانیه'],
    ['1\u202f234,5', 'Mo'],
  ])('preserves localized numbers and units: %s %s', (number, unit) => {
    const { container } = render(<KpiNumber value={`${number} ${unit}`} />)
    const spans = container.querySelectorAll('[data-slot="kpi-number"] > span')
    expect(spans).toHaveLength(2)
    expect(spans[0].textContent).toBe(number)
    expect(spans[1]).toHaveTextContent(unit)
  })

  it('renders the full value while separating the number and unit', () => {
    const { container } = render(<KpiNumber value="1.2 MB/s" />)
    const el = container.firstElementChild as HTMLElement
    expect(el).toHaveTextContent('1.2 MB/s')
    expect(screen.getByText('1.2')).toBeInTheDocument()
    expect(screen.getByText('MB/s')).toBeInTheDocument()
  })

  it('preserves a long value in its text and title', () => {
    const { container } = render(
      <KpiNumber value="12345678901234567890 MB/s" />
    )
    const el = container.firstElementChild as HTMLElement

    expect(el).toHaveAttribute('title', '12345678901234567890 MB/s')
    expect(el).toHaveTextContent('12345678901234567890 MB/s')
  })

  it.each([
    { variant: 'inherit' as const, className: undefined },
    { variant: 'compact' as const, className: undefined },
    { variant: 'inherit' as const, className: 'text-[22px]' },
  ])(
    'preserves the line height when merging $variant with $className',
    ({ variant, className }) => {
      const { container } = render(
        <KpiNumber value="42 MB" variant={variant} className={className} />
      )

      expect(container.firstElementChild).toHaveClass('leading-none')
    }
  )
})
