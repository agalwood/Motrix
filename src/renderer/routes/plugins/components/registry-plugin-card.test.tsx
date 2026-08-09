import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import type { RegistryPluginDTO } from '@shared/schemas/registry'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { RegistryPluginCard } from './registry-plugin-card'

function makeEntry(
  overrides: Partial<RegistryPluginDTO> = {}
): RegistryPluginDTO {
  return {
    id: 'example.archive-unpacker',
    listing: {
      defaultLocale: 'en-US',
      localizations: {
        'en-US': {
          name: 'Example Archive Unpacker',
          description: 'Unpacks finished archives.',
        },
        'zh-CN': { name: '示例压缩包解压器' },
      },
    },
    version: '2.1.0',
    author: { name: 'Example Dev' },
    origin: 'community',
    categories: ['post-action'],
    engines: { motrix: '>=2.1.0 <3.0.0' },
    permissions: [],
    optionalPermissions: [],
    hostPermissions: [],
    screenshots: [],
    updatedAt: '2026-07-08',
    featured: false,
    compatible: true,
    ...overrides,
  }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderCard(entry: RegistryPluginDTO) {
  return render(
    <MemoryRouter initialEntries={['/plugins']}>
      <Routes>
        <Route
          path="/plugins"
          element={
            <>
              <RegistryPluginCard entry={entry} />
              <LocationProbe />
            </>
          }
        />
        <Route path="/plugins/:id" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('RegistryPluginCard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('renders name, author and version from the entry', () => {
    renderCard(makeEntry())
    expect(screen.getByText('Example Archive Unpacker')).toBeInTheDocument()
    expect(screen.getByText(/Example Dev/)).toBeInTheDocument()
    expect(screen.getByText(/v2\.1\.0/)).toBeInTheDocument()
  })

  it('shows the requires badge only when incompatible', () => {
    const { unmount } = renderCard(makeEntry({ compatible: false }))
    expect(screen.getByText(/>=2\.1\.0 <3\.0\.0/)).toBeInTheDocument()
    unmount()

    renderCard(makeEntry({ compatible: true }))
    expect(screen.queryByText(/>=2\.1\.0 <3\.0\.0/)).not.toBeInTheDocument()
  })

  it('navigates to the plugin detail route on click', () => {
    renderCard(makeEntry())
    fireEvent.click(
      screen.getByTestId('registry-card-example.archive-unpacker')
    )
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/plugins/example.archive-unpacker'
    )
  })

  it('updates localized text live without replacing the entry', async () => {
    renderCard(makeEntry())
    expect(screen.getByText('Example Archive Unpacker')).toBeInTheDocument()

    await act(async () => {
      await i18n.changeLanguage('zh-CN')
    })

    expect(screen.getByText('示例压缩包解压器')).toBeInTheDocument()
    expect(screen.getByText('Unpacks finished archives.')).toBeInTheDocument()
  })

  it('does not resolve zh-TW through an unrelated zh-CN record', () => {
    // Listing locale inputs are deliberately wider than the App resource
    // catalog; inject the raw i18next request value at this boundary.
    i18n.language = 'zh-TW'
    renderCard(makeEntry())

    expect(screen.getByText('Example Archive Unpacker')).toBeInTheDocument()
    expect(screen.queryByText('示例压缩包解压器')).toBeNull()
  })
})
