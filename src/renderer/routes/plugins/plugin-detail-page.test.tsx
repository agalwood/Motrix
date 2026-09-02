import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import {
  type PlatformServices,
  PlatformServicesProvider,
} from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import type { PluginListDTO } from '@shared/types/plugin'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

const {
  mockApplyStatus,
  mockClearUpdate,
  mockInvoke,
  mockSetRegistry,
  mockSetUpdates,
  mockStore,
  toastAddMock,
} = vi.hoisted(() => ({
  mockApplyStatus: vi.fn(),
  // Must be a single stable reference (not created fresh per selector call)
  // — BuiltinUpdateDialog depends on it in a useEffect array, and an
  // unstable reference re-triggers that effect's setPhase() on every
  // render, infinite-looping.
  mockClearUpdate: vi.fn(),
  mockInvoke: vi.fn().mockResolvedValue(undefined),
  // useRegistryUpdates (now mounted by the detail page too) writes the scan
  // result back through these setters; stable no-op refs keep its mount
  // effect from throwing on an undefined store action.
  mockSetRegistry: vi.fn(),
  mockSetUpdates: vi.fn(),
  toastAddMock: vi.fn(),
  mockStore: {
    loaded: false,
    list: [] as PluginListDTO[],
    updates: {} as Record<
      string,
      { latestVersion: string; channel: 'community' | 'builtin' }
    >,
  },
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: mockInvoke,
    on: vi.fn(),
    off: vi.fn(),
  },
}))

vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: toastAddMock, close: vi.fn() },
}))

const mockDetail = {
  manifest: {
    manifestVersion: 1,
    id: 'test.demo',
    name: 'Demo',
    version: '1.0',
    description: 'A demo plugin description.',
    permissions: ['storage'],
    optionalPermissions: [],
    hostPermissions: [],
    activationEvents: [],
    categories: [],
    engines: { motrix: '^1.0.0' },
    main: 'index.js',
    contributes: {},
  },
  grants: {},
  config: {},
}

vi.mock('./hooks/use-plugin-detail', () => ({
  usePluginDetail: () => mockDetail,
}))
vi.mock('./hooks/use-plugins', () => ({
  usePlugins: () => {},
}))
vi.mock('./store', () => ({
  usePluginsStore: (selector: (state: unknown) => unknown) =>
    selector({
      loaded: mockStore.loaded,
      list: mockStore.list,
      registry: [],
      updates: mockStore.updates,
      applyStatus: mockApplyStatus,
      setRegistry: mockSetRegistry,
      setUpdates: mockSetUpdates,
      // BuiltinUpdateDialog (rendered for real by these tests, not mocked)
      // reads this to drop the "Update to vX" affordance on success.
      clearUpdate: mockClearUpdate,
    }),
}))

import { PluginDetailPage } from './plugin-detail-page'

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

function renderAt(path: string, kind: 'electron' | 'web' = 'electron') {
  return render(
    <PlatformServicesProvider services={services(kind)}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/plugins" element={<div>Plugin list route</div>} />
            <Route path="/plugins/:id" element={<PluginDetailPage />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </PlatformServicesProvider>
  )
}

function makeListEntry(overrides: Partial<PluginListDTO> = {}): PluginListDTO {
  return {
    id: 'test.demo',
    name: 'Demo',
    version: '1.0',
    description: 'd',
    status: 'inactive',
    enabled: true,
    permissions: ['storage'],
    optionalPermissions: [],
    errorCount: 0,
    source: { type: 'github', url: 'a/b', recordedAt: 0 },
    ...overrides,
  }
}

describe('PluginDetailPage', () => {
  beforeEach(() => {
    mockApplyStatus.mockClear()
    mockClearUpdate.mockClear()
    mockInvoke.mockClear()
    mockSetRegistry.mockClear()
    mockSetUpdates.mockClear()
    toastAddMock.mockClear()
    mockStore.loaded = true
    mockStore.list.length = 0
    mockStore.list.push(makeListEntry())
    mockStore.updates = {}
  })

  it('renders Overview tab by default with audience hero', () => {
    renderAt('/plugins/test.demo')
    // Plugin name now appears in both PanelShell header and the merged
    // OverviewSection identity block, so allow multiple matches.
    expect(screen.getAllByText('Demo').length).toBeGreaterThan(0)
    expect(screen.getByText('Ready')).toBeInTheDocument()
  })

  it('renders primary tabs Overview and Access', () => {
    renderAt('/plugins/test.demo')
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Access' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Advanced/ })).toBeNull()
  })

  it('Logs icon button switches to Logs content', async () => {
    const user = userEvent.setup()
    renderAt('/plugins/test.demo')
    await user.click(screen.getByRole('button', { name: 'Logs' }))
    expect(screen.getByText('Verbose mode')).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Log level' })
    ).toBeInTheDocument()
    expect(screen.getByText('Live output')).toBeInTheDocument()
    expect(screen.getByText('0 entries')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled()
  })

  it('Switch toggles plugin enabled state through command and local store', async () => {
    const user = userEvent.setup()
    renderAt('/plugins/test.demo')

    await user.click(screen.getByRole('switch', { name: 'Enabled' }))

    expect(mockInvoke).toHaveBeenCalledWith(
      'command:disablePlugin',
      'test.demo'
    )
    expect(mockApplyStatus).toHaveBeenCalledWith(
      'test.demo',
      'disabled',
      undefined,
      false
    )
  })

  it('renders Uninstall icon button beside Logs', () => {
    renderAt('/plugins/test.demo')
    const logs = screen.getByRole('button', { name: 'Logs' })
    const uninstall = screen.getByRole('button', { name: 'Uninstall' })
    expect(logs.parentElement).toContainElement(uninstall)
    expect(screen.queryByText('Remove plugin')).toBeNull()
  })

  it('does not render uninstall inside tabpanel content', () => {
    renderAt('/plugins/test.demo')
    expect(screen.getByRole('tabpanel')).not.toContainElement(
      screen.getByRole('button', { name: 'Uninstall' })
    )
  })

  it('reads ?tab= query param to preselect tab', () => {
    renderAt('/plugins/test.demo?tab=access')
    expect(screen.getByRole('tab', { name: 'Access' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('shows loading state when the store has not yet been hydrated', () => {
    mockStore.loaded = false
    mockStore.list.length = 0

    renderAt('/plugins/test.demo')

    expect(screen.queryByRole('tab', { name: 'Overview' })).toBeNull()
  })

  it('returns to plugin list when the loaded store no longer contains this plugin', async () => {
    mockStore.loaded = true
    mockStore.list.length = 0

    renderAt('/plugins/test.demo')

    expect(await screen.findByText('Plugin list route')).toBeInTheDocument()
  })

  it('scans for plugin updates on mount under the electron platform', () => {
    // Deeplinks (motrix://plugins/<id>) land straight on this sibling route,
    // so PluginsPage never mounts — the detail page must itself kick off the
    // update scan or the "Update to vX" affordance can never appear here.
    renderAt('/plugins/test.demo')

    expect(mockInvoke).toHaveBeenCalledWith(Commands.CheckPluginUpdates, {})
  })

  it('scans for community plugin updates on the web platform', () => {
    renderAt('/plugins/test.demo', 'web')

    expect(mockInvoke).toHaveBeenCalledWith(Commands.CheckPluginUpdates, {})
  })

  it('offers a manual check that forces a registry rescan', async () => {
    const user = userEvent.setup()
    renderAt('/plugins/test.demo')

    await user.click(screen.getByTestId('plugin-detail-refresh-btn'))

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(Commands.CheckPluginUpdates, {
        force: true,
      })
    )
  })

  it('renders the manual community check button on the web platform', () => {
    renderAt('/plugins/test.demo', 'web')

    expect(screen.getByTestId('plugin-detail-refresh-btn')).toBeInTheDocument()
  })

  it('renders the update button once the scan populates the updates map', () => {
    mockStore.updates = {
      'test.demo': { latestVersion: '1.2.0', channel: 'builtin' },
    }

    renderAt('/plugins/test.demo')

    // The check icon morphs into the update affordance: aria-label/tooltip
    // carry the target version, and the plain check state is replaced.
    const btn = screen.getByTestId('plugin-update-btn')
    expect(btn).toHaveAttribute('aria-label', 'Update to v1.2.0')
    expect(screen.queryByTestId('plugin-detail-refresh-btn')).toBeNull()
  })

  it('opens BuiltinUpdateDialog when the update channel is builtin', async () => {
    const user = userEvent.setup()
    mockStore.updates = {
      'test.demo': { latestVersion: '1.2.0', channel: 'builtin' },
    }

    renderAt('/plugins/test.demo')
    await user.click(screen.getByTestId('plugin-update-btn'))

    expect(await screen.findByText('Update builtin plugin')).toBeInTheDocument()
    expect(screen.queryByText('Add plugin')).toBeNull()
  })

  it('opens the community PluginInstallDialog when the update channel is community', async () => {
    const user = userEvent.setup()
    mockStore.updates = {
      'test.demo': { latestVersion: '1.2.0', channel: 'community' },
    }

    renderAt('/plugins/test.demo')
    await user.click(screen.getByTestId('plugin-update-btn'))

    expect(await screen.findByText('Add plugin')).toBeInTheDocument()
    expect(screen.queryByText('Update builtin plugin')).toBeNull()
  })

  it('keeps the builtin dialog when its success path clears the update entry', async () => {
    const user = userEvent.setup()
    // Real-store semantics: BuiltinUpdateDialog's success path calls
    // clearUpdate(pluginId), which removes the entry and re-renders every
    // subscriber. Mirror both halves here (mutation + rerender) to reproduce
    // the swap the live zustand store performs.
    mockClearUpdate.mockImplementation((pluginId: string) => {
      delete mockStore.updates[pluginId]
    })
    mockStore.updates = {
      'test.demo': { latestVersion: '1.1.1', channel: 'builtin' },
    }
    mockInvoke.mockImplementation((channel: string) =>
      channel === Commands.InstallBuiltinUpdate
        ? Promise.resolve({ ok: true, restartRequired: false })
        : Promise.resolve(undefined)
    )

    // Fresh element references per call: the mocked store has no
    // subscription, so the store-driven re-render the live zustand store
    // performs is simulated by rerender() — which only re-renders the
    // subtree when the elements are NOT reference-identical.
    const makeUi = () => (
      <PlatformServicesProvider services={services('electron')}>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/plugins/test.demo']}>
            <Routes>
              <Route path="/plugins" element={<div>Plugin list route</div>} />
              <Route path="/plugins/:id" element={<PluginDetailPage />} />
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </PlatformServicesProvider>
    )
    const view = render(makeUi())
    await user.click(screen.getByTestId('plugin-update-btn'))

    // The builtin update auto-runs on open, succeeds, and clears the entry.
    await waitFor(() =>
      expect(mockClearUpdate).toHaveBeenCalledWith('test.demo')
    )
    view.rerender(makeUi())

    // The open dialog must keep its builtin identity: no ghost "Add plugin"
    // dialog, and no community install fired for a builtin (main would
    // reject the reserved motrix.* namespace with a user-facing error).
    expect(screen.getByText('Update builtin plugin')).toBeInTheDocument()
    expect(screen.queryByText('Add plugin')).toBeNull()
    expect(mockInvoke).not.toHaveBeenCalledWith(
      Commands.InstallPlugin,
      expect.anything()
    )
  })

  it('does not render the revert button for a non-builtin-update source', () => {
    renderAt('/plugins/test.demo')
    expect(screen.queryByTestId('builtin-revert-btn')).toBeNull()
  })

  it('renders the revert button and invokes RevertBuiltinToBundled when source is builtin-update', async () => {
    const user = userEvent.setup()
    mockStore.list.length = 0
    mockStore.list.push(
      makeListEntry({
        source: { type: 'builtin-update', url: 'a/b', recordedAt: 0 },
      })
    )
    mockInvoke.mockImplementation((channel: string) =>
      channel === Commands.RevertBuiltinToBundled
        ? Promise.resolve({ ok: true, restartRequired: false })
        : Promise.resolve(undefined)
    )

    renderAt('/plugins/test.demo')
    await user.click(screen.getByTestId('builtin-revert-btn'))

    expect(mockInvoke).toHaveBeenCalledWith(Commands.RevertBuiltinToBundled, {
      pluginId: 'test.demo',
    })
  })

  it('does not render the revert button on the web platform even for a builtin-update source', () => {
    mockStore.list.length = 0
    mockStore.list.push(
      makeListEntry({
        source: { type: 'builtin-update', url: 'a/b', recordedAt: 0 },
      })
    )

    renderAt('/plugins/test.demo', 'web')

    expect(screen.queryByTestId('builtin-revert-btn')).toBeNull()
  })

  it('toasts the restart notice when revert reports restartRequired', async () => {
    const user = userEvent.setup()
    mockStore.list.length = 0
    mockStore.list.push(
      makeListEntry({
        source: { type: 'builtin-update', url: 'a/b', recordedAt: 0 },
      })
    )
    mockInvoke.mockImplementation((channel: string) =>
      channel === Commands.RevertBuiltinToBundled
        ? Promise.resolve({ ok: true, restartRequired: true })
        : Promise.resolve(undefined)
    )

    renderAt('/plugins/test.demo')
    await user.click(screen.getByTestId('builtin-revert-btn'))

    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Update installed. Restart Motrix to finish applying it.',
      })
    )
  })

  it('toasts an error when the revert invoke rejects, without throwing', async () => {
    const user = userEvent.setup()
    mockStore.list.length = 0
    mockStore.list.push(
      makeListEntry({
        source: { type: 'builtin-update', url: 'a/b', recordedAt: 0 },
      })
    )
    mockInvoke.mockImplementation((channel: string) =>
      channel === Commands.RevertBuiltinToBundled
        ? Promise.reject(new Error('revert failed'))
        : Promise.resolve(undefined)
    )

    renderAt('/plugins/test.demo')
    await user.click(screen.getByTestId('builtin-revert-btn'))

    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'The action could not be completed.' })
    )
  })
})
