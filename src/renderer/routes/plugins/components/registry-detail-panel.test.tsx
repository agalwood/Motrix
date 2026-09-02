import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import {
  type PlatformServices,
  PlatformServicesProvider,
} from '@renderer/platform/services'
import type { RegistryPluginDTO } from '@shared/schemas/registry'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../plugin-install-dialog', () => ({
  PluginInstallDialog: () => null,
}))

import { RegistryDetailPanel } from './registry-detail-panel'

function services(kind: 'electron' | 'web'): PlatformServices {
  return {
    kind,
    pickSaveDir: async () => null,
    closeHost: () => {},
    readClipboard: async () => '',
    openExternal: () => {},
    notify: () => {},
  }
}

function entry(over: Partial<RegistryPluginDTO> = {}): RegistryPluginDTO {
  return {
    id: 'acme.speed-boost',
    listing: {
      defaultLocale: 'en-US',
      localizations: {
        'en-US': {
          name: 'Speed Boost',
          description: 'Boosts speed',
          features: ['Fast downloads'],
        },
        'zh-Hant': { description: '繁體說明', features: [] },
      },
    },
    version: '1.0.0',
    author: { name: 'Acme' },
    origin: 'community',
    categories: ['network'],
    engines: { motrix: '^2.0.0' },
    permissions: [],
    optionalPermissions: [],
    hostPermissions: [],
    screenshots: [],
    updatedAt: '2026-07-01',
    featured: false,
    compatible: true,
    package: {
      url: 'https://dl.motrix.app/p/x.moext',
      sha256: 'a'.repeat(64),
      size: 10,
    },
    ...over,
  }
}

function renderPanel(kind: 'electron' | 'web', e: RegistryPluginDTO) {
  return render(
    <PlatformServicesProvider services={services(kind)}>
      <RegistryDetailPanel entry={e} />
    </PlatformServicesProvider>
  )
}

describe('RegistryDetailPanel install affordance', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('shows an enabled Install button on electron for a compatible entry', () => {
    renderPanel('electron', entry())
    expect(screen.getByTestId('registry-install-btn')).toBeEnabled()
  })

  it('shows a disabled Install button for an incompatible entry', () => {
    renderPanel('electron', entry({ compatible: false }))
    expect(screen.getByTestId('registry-install-btn')).toBeDisabled()
  })

  it('shows the verified registry Install button on web', () => {
    renderPanel('web', entry())
    expect(screen.getByTestId('registry-install-btn')).toBeEnabled()
  })

  it('resolves sparse fields and honors an explicit empty features override', () => {
    // Registry requests accept BCP 47 values outside bundled App resources.
    i18n.language = 'zh-Hant-TW'
    renderPanel('electron', entry())

    expect(screen.getByText('Speed Boost')).toBeInTheDocument()
    expect(screen.getByText('繁體說明')).toBeInTheDocument()
    expect(screen.queryByText('Fast downloads')).toBeNull()
    expect(screen.queryByText('Features')).toBeNull()
  })
})
