import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { i18n } from '@renderer/lib/i18n'
import {
  type PlatformServices,
  PlatformServicesProvider,
} from '@renderer/platform/services'
import { Queries } from '@shared/protocol/queries'
import type { RegistryPluginDTO } from '@shared/schemas/registry'
import type { PluginListDTO } from '@shared/types/plugin'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(() => new Promise(() => {})),
}))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: mockInvoke, on: vi.fn(), off: vi.fn() },
}))

let mockList: PluginListDTO[] = []
let mockRegistry: RegistryPluginDTO[] = []
vi.mock('./hooks/use-plugins', () => ({
  usePlugins: () => mockList,
}))
vi.mock('./hooks/use-registry', () => ({
  useRegistryPlugins: () => mockRegistry,
  useRegistryUpdates: () => ({ refreshing: false, refresh: vi.fn() }),
}))

import { PluginsPage } from './plugins-page'
import { usePluginsStore } from './store'

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

function renderPage(kind: 'electron' | 'web' = 'electron') {
  return render(
    <PlatformServicesProvider services={services(kind)}>
      <TooltipProvider>
        <MemoryRouter>
          <PluginsPage />
        </MemoryRouter>
      </TooltipProvider>
    </PlatformServicesProvider>
  )
}

function plugin(over: Partial<PluginListDTO> = {}): PluginListDTO {
  return {
    id: 'test.id',
    name: 'Test Plugin',
    version: '1.0.0',
    description: 'A test.',
    status: 'inactive',
    enabled: true,
    permissions: [],
    optionalPermissions: [],
    errorCount: 0,
    ...over,
  } as PluginListDTO
}

function registryPlugin(
  over: Partial<RegistryPluginDTO> = {}
): RegistryPluginDTO {
  return {
    id: 'example.archive-unpacker',
    listing: {
      defaultLocale: 'en-US',
      localizations: {
        'en-US': {
          name: 'Archive Unpacker',
          description: 'Extracts finished downloads',
          keywords: ['archive'],
        },
        'zh-CN': {
          name: '中文解压器',
          description: '解压下载内容',
          keywords: ['压缩包'],
        },
        'ja-JP': { name: 'アーカイブ展開' },
      },
    },
    version: '1.0.0',
    author: { name: 'Example Dev' },
    origin: 'community',
    categories: ['post-action'],
    engines: { motrix: '^2.0.0' },
    permissions: [],
    optionalPermissions: [],
    hostPermissions: [],
    screenshots: [],
    updatedAt: '2026-08-02',
    featured: false,
    compatible: true,
    ...over,
  }
}

describe('PluginsPage', () => {
  beforeEach(async () => {
    mockList = []
    mockRegistry = []
    mockInvoke.mockClear()
    usePluginsStore.setState({ loaded: true, updates: {} })
    await i18n.changeLanguage('en-US')
  })

  it('shows neutral loading content before classifying an empty inventory', () => {
    usePluginsStore.setState({ loaded: false })
    renderPage()

    const scrollRegion = screen.getByTestId('plugins-scroll-region')
    const search = screen.getByPlaceholderText('Find a plugin')
    const diagnostics = screen.getByRole('link', {
      name: 'Diagnostics',
    })

    expect(scrollRegion).toHaveAttribute('aria-busy', 'true')
    expect(scrollRegion).not.toContainElement(search)
    expect(scrollRegion).not.toContainElement(diagnostics)
    expect(
      scrollRegion.querySelector('[data-slot="skeleton"]')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('plugin-first-use-guide')).toBeNull()
    expect(screen.queryByTestId('plugin-safety-reminder')).toBeNull()
    expect(screen.queryByText('Add plugins you trust')).toBeNull()
  })

  it('does not request the plugin command graph on the default route', () => {
    renderPage()
    expect(mockInvoke).not.toHaveBeenCalledWith(Queries.GetPluginCommandGraph)
  })

  it('uses the first-use guide as the empty state without a duplicate hero', () => {
    renderPage()

    expect(screen.getByTestId('plugins-scroll-region')).toHaveAttribute(
      'aria-busy',
      'false'
    )
    expect(screen.getByText('Add plugins you trust')).toBeInTheDocument()
    expect(screen.queryByText('No plugins installed yet')).toBeNull()
    // The header owns the ONE "Add plugin" entry point; the first-use guide
    // is pure guidance and must not duplicate it.
    expect(screen.getAllByRole('button', { name: 'Add plugin' })).toHaveLength(
      1
    )
  })

  it('opens the install dialog from the header action', () => {
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Add plugin' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Paste a GitHub/i)).toBeInTheDocument()
  })

  it('shows first-use guidance when every plugin is bundled', () => {
    mockList = [
      plugin({
        source: { type: 'builtin', url: 'builtin', recordedAt: 0 },
      }),
    ]
    renderPage()

    expect(screen.getByTestId('plugin-first-use-guide')).toBeInTheDocument()
    expect(screen.getByText('Test Plugin')).toBeInTheDocument()
  })

  it('shows compact safety guidance for a plugin with missing source metadata', () => {
    mockList = [plugin()]
    renderPage()

    expect(screen.getByTestId('plugin-safety-reminder')).toBeInTheDocument()
    expect(screen.queryByTestId('plugin-first-use-guide')).toBeNull()
  })

  it('keeps search and diagnostics outside the plugin content scroller', () => {
    mockList = [plugin()]
    renderPage()

    const scrollRegion = screen.getByTestId('plugins-scroll-region')
    const search = screen.getByPlaceholderText('Find a plugin')
    const diagnostics = screen.getByRole('link', {
      name: 'Diagnostics',
    })

    expect(scrollRegion).toHaveClass('overflow-y-auto')
    expect(scrollRegion).not.toContainElement(search)
    expect(scrollRegion).not.toContainElement(diagnostics)
    expect(scrollRegion).toContainElement(screen.getByText('Test Plugin'))
    expect(scrollRegion).toContainElement(
      screen.getByTestId('plugin-safety-reminder')
    )
  })

  it('links the fixed tool row to the diagnostics page', () => {
    renderPage()
    expect(screen.getByRole('link', { name: 'Diagnostics' })).toHaveAttribute(
      'href',
      '/plugins/diagnostics'
    )
  })

  it('inherits the shared Input focus ring', () => {
    renderPage()
    const input = screen.getByPlaceholderText('Find a plugin')

    expect(input).toHaveClass('focus-visible:border-ring')
    expect(input).toHaveClass('focus-visible:ring-[3px]')
    expect(input).toHaveClass('focus-visible:ring-ring/50')
    expect(input).not.toHaveClass('focus-visible:ring-0')
  })

  it('filters cards by search query', () => {
    mockList = [
      plugin({ id: 'a', name: 'Alpha' }),
      plugin({ id: 'b', name: 'Beta' }),
    ]
    renderPage()

    fireEvent.change(screen.getByPlaceholderText('Find a plugin'), {
      target: { value: 'beta' },
    })

    expect(screen.queryByText('Alpha')).toBeNull()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('shows the no-match message and clears the query', () => {
    mockList = [plugin()]
    renderPage()

    fireEvent.change(screen.getByPlaceholderText('Find a plugin'), {
      target: { value: 'zzz' },
    })
    expect(screen.getByText(/No plugins match “zzz”/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByText('Test Plugin')).toBeInTheDocument()
  })

  it('shows the registry refresh button on electron', () => {
    renderPage()
    expect(screen.getByTestId('registry-refresh-btn')).toBeInTheDocument()
  })

  it('shows the community registry refresh button on web', () => {
    renderPage('web')
    expect(screen.getByTestId('registry-refresh-btn')).toBeInTheDocument()
  })

  it('marks an installed plugin that has a registry update', () => {
    mockList = [plugin({ id: 'acme.speed-boost', name: 'Speed Boost' })]
    usePluginsStore.setState({
      updates: {
        'acme.speed-boost': { latestVersion: '1.1.0', channel: 'community' },
      },
    })
    renderPage()
    expect(screen.getByText('Update available')).toBeInTheDocument()
  })

  it('searches resolved and default fields including keywords', () => {
    mockRegistry = [registryPlugin()]
    renderPage()

    fireEvent.change(screen.getByPlaceholderText('Find a plugin'), {
      target: { value: 'archive' },
    })
    expect(
      screen.getByTestId('registry-card-example.archive-unpacker')
    ).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Find a plugin'), {
      target: { value: 'アーカイブ' },
    })
    expect(
      screen.queryByTestId('registry-card-example.archive-unpacker')
    ).toBeNull()
  })

  it('recomputes a non-empty registry search on live language change without refetch', async () => {
    mockRegistry = [registryPlugin()]
    renderPage()
    fireEvent.change(screen.getByPlaceholderText('Find a plugin'), {
      target: { value: '压缩包' },
    })
    expect(
      screen.queryByTestId('registry-card-example.archive-unpacker')
    ).toBeNull()

    await act(async () => {
      await i18n.changeLanguage('zh-CN')
    })

    expect(
      screen.getByTestId('registry-card-example.archive-unpacker')
    ).toBeInTheDocument()
    expect(screen.getByText('中文解压器')).toBeInTheDocument()
    expect(mockInvoke).not.toHaveBeenCalledWith(Queries.ListRegistryPlugins)
  })
})
