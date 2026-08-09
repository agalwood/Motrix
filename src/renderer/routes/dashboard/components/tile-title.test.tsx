import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { TileTitle, type TileTitleProps } from './tile-title'

type MetricTileTitleProps = Extract<TileTitleProps, { variant?: 'metric' }>

type HasRawHtmlProp = 'dangerouslySetInnerHTML' extends keyof TileTitleProps
  ? true
  : false

describe('TileTitle', () => {
  it('renders ordinary text in the fixed title line box', () => {
    const { container } = render(<TileTitle variant="text">Ready</TileTitle>)
    const title = container.querySelector('[data-slot="tile-title"]')

    expect(title).toHaveTextContent('Ready')
    expect(title).toHaveClass('text-[22px]', 'h-8', 'leading-none')
    expect(screen.getByText('Ready')).toHaveClass('truncate', 'leading-[26px]')
  })

  it('lets KpiNumber inherit the same font size and line box', () => {
    const { container } = render(<TileTitle value="42 MB" />)
    const title = container.querySelector<HTMLElement>(
      '[data-slot="tile-title"]'
    )
    const kpi = container.querySelector<HTMLElement>('[data-slot="kpi-number"]')

    expect(title).toContainElement(kpi)
    expect(title).toHaveClass('text-[32px]', 'h-8')
    expect(kpi).toHaveClass('leading-none')
    expect(kpi?.className).not.toContain('text-[')
  })

  it('keeps the metric and text content contracts closed', () => {
    expectTypeOf<MetricTileTitleProps['value']>().toEqualTypeOf<
      string | number
    >()
    expectTypeOf<MetricTileTitleProps['children']>().toEqualTypeOf<undefined>()
    expectTypeOf<HasRawHtmlProp>().toEqualTypeOf<false>()
  })

  it('passes non-visual div attributes without exposing geometry overrides', () => {
    const { container } = render(
      <TileTitle variant="text" title="Complete state label">
        Custom
      </TileTitle>
    )
    const title = container.querySelector('[data-slot="tile-title"]')

    expect(title).toHaveAttribute('title', 'Complete state label')
    expect(title).not.toHaveAttribute('style')
    expect(title).toHaveClass('text-[22px]', 'h-8', 'leading-none')
  })
})
