import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { TileTitle, type TileTitleProps } from './tile-title'

type MetricTileTitleProps = Extract<TileTitleProps, { variant?: 'metric' }>

type HasRawHtmlProp = 'dangerouslySetInnerHTML' extends keyof TileTitleProps
  ? true
  : false

describe('TileTitle', () => {
  it('renders a text title', () => {
    const { container } = render(<TileTitle variant="text">Ready</TileTitle>)
    const title = container.querySelector('[data-slot="tile-title"]')

    expect(title).toHaveTextContent('Ready')
  })

  it('renders a metric title through KpiNumber', () => {
    const { container } = render(<TileTitle value="42 MB" />)
    const title = container.querySelector<HTMLElement>(
      '[data-slot="tile-title"]'
    )
    const kpi = container.querySelector<HTMLElement>('[data-slot="kpi-number"]')

    expect(title).toContainElement(kpi)
    expect(title).toHaveTextContent('42 MB')
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
  })
})
