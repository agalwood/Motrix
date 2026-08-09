import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PluginAudienceBadge } from './plugin-audience-badge'

describe('PluginAudienceBadge', () => {
  it('renders "Looks safe" for safe tone', () => {
    render(<PluginAudienceBadge tone="safe" />)
    expect(screen.getByText('Looks safe')).toBeInTheDocument()
  })

  it('applies the amber palette for review tone', () => {
    const { container } = render(<PluginAudienceBadge tone="review" />)
    expect(container.firstChild).toHaveClass('bg-amber-100', 'text-amber-700')
  })

  it('applies the slate palette for off tone', () => {
    const { container } = render(<PluginAudienceBadge tone="off" />)
    expect(container.firstChild).toHaveClass('bg-slate-100', 'text-slate-600')
  })
})
