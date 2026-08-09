import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@renderer/lib/i18n'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import type { PluginListDTO } from '@shared/types/plugin'
import { usePluginsStore } from '../store'
import { PluginCard } from './plugin-card'

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: mockInvoke, on: vi.fn(), off: vi.fn() },
}))

function makePlugin(overrides: Partial<PluginListDTO> = {}): PluginListDTO {
  return {
    id: 'test.demo-config',
    name: 'Demo Config Plugin',
    version: '1.0.0',
    description: 'Adds a few download preferences.',
    status: 'inactive',
    enabled: true,
    permissions: [],
    optionalPermissions: [],
    errorCount: 0,
    ...overrides,
  } as PluginListDTO
}

function renderCard(plugin: PluginListDTO) {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={['/plugins']}>
        <Routes>
          <Route
            path="/plugins"
            element={<PluginCard plugin={plugin} hasSchema={false} />}
          />
          <Route
            path="/plugins/:id"
            element={<div data-testid="detail-route">Plugin detail</div>}
          />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>
  )
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderCardWithLocation(plugin: PluginListDTO) {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={['/plugins']}>
        <Routes>
          <Route
            path="/plugins"
            element={
              <>
                <LocationProbe />
                <PluginCard plugin={plugin} hasSchema={false} />
              </>
            }
          />
          <Route
            path="/plugins/:id"
            element={
              <>
                <LocationProbe />
                <div data-testid="detail-route">Plugin detail</div>
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>
  )
}

describe('PluginCard', () => {
  beforeEach(() => {
    mockInvoke.mockClear()
    usePluginsStore.setState({ list: [], detail: {} })
  })

  it('renders identity (avatar fallback + name + one-liner)', () => {
    renderCard(makePlugin())
    expect(screen.getByText('DC')).toBeInTheDocument()
    expect(screen.getByText('Demo Config Plugin')).toBeInTheDocument()
    expect(
      screen.getByText('Adds a few download preferences.')
    ).toBeInTheDocument()
  })

  it('safe tone: shows Looks safe badge', () => {
    renderCard(makePlugin())
    expect(screen.getByText('Looks safe')).toBeInTheDocument()
  })

  it('error tone: shows Needs review + View issue', () => {
    renderCard(makePlugin({ errorCount: 1 }))
    expect(screen.getByText('Needs review')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'View issue' })
    ).toBeInTheDocument()
  })

  it('off state: switch is unchecked, audience badge hidden, Turn on is primary action', () => {
    renderCard(makePlugin({ enabled: false, status: 'disabled' }))
    const switchEl = screen.getByRole('switch')
    expect(switchEl).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByText('Off')).toBeNull()
    expect(screen.queryByText('Looks safe')).toBeNull()
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeInTheDocument()
  })

  it('Turn on button invokes EnablePlugin command', async () => {
    renderCard(makePlugin({ enabled: false, status: 'disabled' }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        'command:enablePlugin',
        'test.demo-config'
      )
    )
  })

  it('Switch toggle invokes DisablePlugin command when enabled', async () => {
    renderCard(makePlugin())
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        'command:disablePlugin',
        'test.demo-config'
      )
    )
  })

  it('does not open plugin detail when the Switch is clicked', async () => {
    renderCardWithLocation(makePlugin())
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.getByTestId('location')).toHaveTextContent('/plugins')
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        'command:disablePlugin',
        'test.demo-config'
      )
    )
  })

  it('applies the disabled state locally after a successful Switch command', async () => {
    const plugin = makePlugin()
    usePluginsStore.getState().setList([plugin])
    renderCard(plugin)

    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() =>
      expect(usePluginsStore.getState().list[0]).toMatchObject({
        enabled: false,
        status: 'disabled',
      })
    )
  })

  it('does not nest the Switch inside the card navigation target', () => {
    renderCard(makePlugin())
    expect(screen.getByRole('switch').closest('a')).toBeNull()
  })

  it('opens plugin detail when the card body is clicked', () => {
    renderCardWithLocation(makePlugin())
    fireEvent.click(screen.getByText('Demo Config Plugin'))
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/plugins/test.demo-config'
    )
  })

  it('badge row renders the error count without graph summaries', () => {
    renderCard(makePlugin({ errorCount: 2 }))
    expect(screen.getByText('2 errors')).toBeInTheDocument()
    expect(screen.queryByText(/Commands invoked:/)).toBeNull()
    expect(screen.queryByText(/Commands serving:/)).toBeNull()
  })
})
