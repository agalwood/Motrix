import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import type { TrustSurfaceDiff } from '@shared/types/plugin-install'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConsentDiffSection } from './consent-diff-section'

const EMPTY_DIFF: TrustSurfaceDiff = {
  permissionsAdded: [],
  optionalPermissionsAdded: [],
  invokesCommandsAdded: [],
  publicCommandsAdded: [],
  publicCommandsSchemaChanged: [],
  hostPermissionsAdded: [],
  requestedHeapMBIncreased: null,
  enginesMotrixMajorChange: null,
  sourceUrlChanged: null,
}

describe('ConsentDiffSection', () => {
  it('renders nothing when an upgrade does not broaden the trust surface', () => {
    const { container } = render(<ConsentDiffSection diff={EMPTY_DIFF} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows added capabilities and scalar trust changes', () => {
    render(
      <ConsentDiffSection
        diff={{
          ...EMPTY_DIFF,
          permissionsAdded: ['storage'],
          hostPermissionsAdded: ['https://example.com/*'],
          publicCommandsSchemaChanged: ['alice.convert'],
          requestedHeapMBIncreased: { from: 32, to: 64 },
          enginesMotrixMajorChange: { from: '^1.0.0', to: '^2.0.0' },
          sourceUrlChanged: {
            from: 'https://old.example/plugin.moext',
            to: 'https://new.example/plugin.moext',
          },
        }}
      />
    )

    expect(screen.getByText('storage')).toBeInTheDocument()
    expect(screen.getByText('https://example.com/*')).toBeInTheDocument()
    expect(screen.getByText('alice.convert')).toBeInTheDocument()
    expect(screen.getByText(/32.*64 MB/)).toBeInTheDocument()
    expect(screen.getByText(/\^1\.0\.0.*\^2\.0\.0/)).toBeInTheDocument()
    expect(
      screen.getByText(/https:\/\/old\.example\/plugin\.moext/)
    ).toBeInTheDocument()
  })
})
