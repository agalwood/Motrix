import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AboutSection } from './about-section'

describe('AboutSection', () => {
  it('renders description without repeating plugin identity', () => {
    render(
      <AboutSection
        manifest={
          {
            id: 'media.video-helper',
            name: 'Video Helper',
            version: '1.2.3',
            description: 'Reads supported video sites.',
          } as never
        }
      />
    )
    expect(screen.queryByText('Video Helper')).toBeNull()
    expect(screen.queryByText('v1.2.3 · media.video-helper')).toBeNull()
    expect(screen.getByText('Reads supported video sites.')).toBeInTheDocument()
  })

  it('renders author when present', () => {
    render(
      <AboutSection
        manifest={
          {
            id: 'x',
            name: 'X',
            version: '1',
            description: '',
            author: 'Alice',
          } as never
        }
      />
    )
    expect(screen.getByText(/Alice/)).toBeInTheDocument()
  })

  it('renders homepage as external link', () => {
    render(
      <AboutSection
        manifest={
          {
            id: 'x',
            name: 'X',
            version: '1',
            description: '',
            homepage: 'https://example.com',
          } as never
        }
      />
    )
    const link = screen.getByRole('link', { name: 'https://example.com' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })
})
