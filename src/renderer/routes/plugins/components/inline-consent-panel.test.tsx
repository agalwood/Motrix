import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import type { ConsentPayload } from '@shared/types/plugin-install'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { InlineConsentPanel } from './inline-consent-panel'

const baseConsent: ConsentPayload = {
  manifest: {
    id: 'media.video-helper',
    name: 'Video Helper',
    version: '1.0.0',
    description: 'Reads supported video sites.',
  },
  source: {
    type: 'github',
    url: 'motrix/video-helper',
    bundleSha256: 'deadbeef',
    recordedAt: 0,
  },
  trustSurface: {
    permissions: [
      { name: 'storage', description: 'plugins.permission.storage.plain' },
      { name: 'network', description: 'plugins.permission.network.plain' },
    ],
    optionalPermissions: [
      {
        name: 'notifications',
        description: 'plugins.permission.notifications.plain',
      },
    ],
    hostPermissions: [],
    invokesCommands: [],
    publicCommandsExposed: [],
    enginesMotrix: '^1.0.0',
    notVerified: true,
  },
  diff: null,
  ffmpegRuntime: { available: false, requiredByPlugin: 'none' },
}

describe('InlineConsentPanel', () => {
  it('renders plugin identity card and the install warning', () => {
    render(
      <InlineConsentPanel
        consent={baseConsent}
        grants={{ notifications: 'denied' }}
        onGrantsChange={() => {}}
      />
    )
    expect(screen.getByText('Video Helper')).toBeInTheDocument()
    expect(screen.getByText(/Reads supported video sites/)).toBeInTheDocument()
    expect(screen.getByText(/Before installing/)).toBeInTheDocument()
  })

  it('renders one PermissionRow per permission (required + optional)', () => {
    render(
      <InlineConsentPanel
        consent={baseConsent}
        grants={{ notifications: 'denied' }}
        onGrantsChange={() => {}}
      />
    )
    expect(screen.getByText('Save settings')).toBeInTheDocument()
    expect(screen.getByText('Read websites')).toBeInTheDocument()
    expect(screen.getByText('Send notifications')).toBeInTheDocument()
  })

  it('shows BroadHostAccessWarning when any host permission is broad', () => {
    const broad: ConsentPayload = {
      ...baseConsent,
      trustSurface: {
        ...baseConsent.trustSurface,
        hostPermissions: [{ pattern: '<all_urls>', broad: true }],
      },
    }
    render(
      <InlineConsentPanel
        consent={broad}
        grants={{}}
        onGrantsChange={() => {}}
      />
    )
    expect(
      screen.getByText(/can read and modify downloads from any URL/i)
    ).toBeInTheDocument()
  })
})
