import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusDot } from './status-dot'

describe('StatusDot', () => {
  it('marks an active dot for the pulse animation', () => {
    const { container } = render(
      <StatusDot pulse className="size-2 bg-emerald-500" />
    )
    const dot = container.querySelector('[data-slot="status-dot"]')

    expect(dot).toHaveAttribute('data-pulse', 'true')
    expect(dot).toHaveAttribute('aria-hidden', 'true')
    expect(dot).toHaveClass('size-2', 'bg-emerald-500')
  })

  it('keeps an inactive dot still', () => {
    const { container } = render(<StatusDot className="bg-gray-500" />)
    const dot = container.querySelector('[data-slot="status-dot"]')

    expect(dot).not.toHaveAttribute('data-pulse')
  })
})
