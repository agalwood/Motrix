import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(async () => undefined),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))
const { toastAddMock } = vi.hoisted(() => ({ toastAddMock: vi.fn() }))
vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: toastAddMock, close: vi.fn() },
}))

import { transport } from '@renderer/lib/transport'
import { NetworkDialog } from './network-dialog'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const FIXTURE = {
  proxy: {
    enabled: false,
    protocol: 'http',
    host: '',
    port: 8080,
    user: '',
    password: '',
    bypass: [],
    scopes: { download: false, updateApp: false, updateTrackers: false },
  },
  nat: {
    enabled: true,
    preferredProtocol: 'auto',
    mappingTtl: 7200,
    natTypeDetectionEnabled: false,
    stunServers: [],
    portReachabilityCheckEnabled: false,
    portCheckerEndpoints: [],
    autoDiagnostic: false,
    diagnosticIntervalSec: 3600,
  },
  engine: {
    dnsMode: 'auto',
  },
}

describe('<NetworkDialog>', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.mocked(transport.invoke).mockReset()
    vi.mocked(transport.invoke).mockImplementation(async (channel: string) => {
      if (channel === Queries.GetSettings) return FIXTURE
      if (channel === Queries.GetSystemProxy)
        return { protocol: 'http', host: '10.0.0.1', port: 3128 }
      return { saved: true, requiresRestart: false, changedRestartKeys: [] }
    })
  })

  it('hydrates and saves dirty proxy fields without restart', async () => {
    const onClose = vi.fn()
    render(
      <NetworkDialog
        open
        onClose={onClose}
        labelKey="settings.cards.network.title"
        descKey="settings.cards.network.desc"
      />
    )
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /^proxy$/i })
      ).toBeInTheDocument()
    )
    const user = userEvent.setup()
    const switches = screen.getAllByRole('switch')
    await user.click(switches[0])
    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => {
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.UpdateSettings,
        expect.objectContaining({
          proxy: expect.objectContaining({ enabled: true }),
        })
      )
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('changing dns resolution submits an engine dnsMode patch', async () => {
    const onClose = vi.fn()
    render(
      <NetworkDialog
        open
        onClose={onClose}
        labelKey="settings.cards.network.title"
        descKey="settings.cards.network.desc"
      />
    )
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /^dns$/i })
      ).toBeInTheDocument()
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox', { name: /dns lookup/i }))
    await user.click(await screen.findByRole('option', { name: /system dns/i }))
    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => {
      expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
        engine: { dnsMode: 'system' },
      })
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('Import from system populates host/port/protocol', async () => {
    render(
      <NetworkDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.network.title"
        descKey="settings.cards.network.desc"
      />
    )
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /^proxy$/i })
      ).toBeInTheDocument()
    )
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: /import from system/i })
    )
    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetSystemProxy)
    await waitFor(() => {
      expect(screen.getByDisplayValue('10.0.0.1')).toBeInTheDocument()
    })
  })
})
