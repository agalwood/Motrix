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
})
