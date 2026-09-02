import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import {
  CliInstallCapability,
  CliPackageManager,
  CliToolPhase,
  CliToolReason,
} from '@shared/types/cli-tool'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable so individual tests can flip the bridge's reported port status
// (Task 21) without redefining the whole `vi.mock` factory per test.
const bridgeStatus = vi.hoisted(() => ({
  current: {
    port: 16802,
    degraded: false,
    extensionPairingHealth: 'ready' as 'ready' | 'degraded',
    fixedPort: 'auto' as const,
    instanceId: 'test-instance',
  },
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn((channel: string) => {
      if (
        channel === 'bridge:listPaired' ||
        channel === 'bridge:listTrusted' ||
        channel === 'bridge:listPendingPairRequests'
      ) {
        return Promise.resolve([])
      }
      if (channel === 'bridge:getStatus') {
        return Promise.resolve(bridgeStatus.current)
      }
      if (channel === 'query:getFfmpegDetection') {
        return Promise.resolve({ active: null, candidates: [] })
      }
      if (channel === 'query:getCliToolStatus') {
        return Promise.resolve({
          phase: CliToolPhase.ManualOnly,
          capability: CliInstallCapability.ManualOnly,
          installCommand: 'npm install -g @motrix/cli@latest',
          packageManager: CliPackageManager.Npm,
          managerOptions: [
            {
              manager: CliPackageManager.Npm,
              installCommand: 'npm install -g @motrix/cli@latest',
              available: false,
            },
            {
              manager: CliPackageManager.Pnpm,
              installCommand: 'pnpm add -g @motrix/cli@latest',
              available: false,
            },
            {
              manager: CliPackageManager.Yarn,
              installCommand: 'yarn global add @motrix/cli@latest',
              available: false,
            },
            {
              manager: CliPackageManager.Bun,
              installCommand: 'bun add -g @motrix/cli@latest',
              available: false,
            },
            {
              manager: CliPackageManager.Volta,
              installCommand: 'volta install @motrix/cli@latest',
              available: false,
            },
          ],
          version: null,
          executablePath: null,
          nodeVersion: null,
          reason: CliToolReason.UnsupportedWeb,
          detail: null,
        })
      }
      return Promise.resolve({})
    }),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

// Base UI Switch needs ResizeObserver in jsdom.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

import { transport } from '@renderer/lib/transport'
import { IntegrationDialog } from './integration-dialog'

describe('IntegrationDialog scaffold', () => {
  beforeEach(() => {
    transport.platform = 'darwin'
    bridgeStatus.current = {
      port: 16802,
      degraded: false,
      extensionPairingHealth: 'ready',
      fixedPort: 'auto',
      instanceId: 'test-instance',
    }
  })

  it('renders the four top-level section headings', async () => {
    render(
      <IntegrationDialog
        open={true}
        onClose={() => {}}
        labelKey="settings.cards.integration.title"
        descKey="settings.cards.integration.desc"
      />
    )
    expect(
      await screen.findByRole('heading', { name: /system protocols/i })
    ).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: /browser extensions/i })
    ).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: /command-line tools/i })
    ).toBeTruthy()
    expect(screen.getByRole('heading', { name: /media tools/i })).toBeTruthy()
  })

  it('hides desktop protocol associations in the web client', async () => {
    transport.platform = 'web'
    render(
      <IntegrationDialog
        open={true}
        onClose={() => {}}
        labelKey="settings.cards.integration.title"
        descKey="settings.cards.integration.desc"
      />
    )

    expect(
      screen.queryByRole('heading', { name: /system protocols/i })
    ).not.toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: /browser extensions/i })
    ).toBeInTheDocument()
  })

  it('places the local CLI card before paired remote tools', async () => {
    render(
      <IntegrationDialog
        open={true}
        onClose={() => {}}
        labelKey="settings.cards.integration.title"
        descKey="settings.cards.integration.desc"
      />
    )

    const local = await screen.findByText('Motrix command-line tool')
    const remote = screen.getByRole('heading', {
      name: /paired remote tools/i,
    })
    expect(
      local.compareDocumentPosition(remote) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getByText(/local CLI connects automatically/i)).toBeTruthy()
  })

  it('renders the complete manual-only unsupported CLI recovery state', async () => {
    render(
      <IntegrationDialog
        open={true}
        onClose={() => {}}
        labelKey="settings.cards.integration.title"
        descKey="settings.cards.integration.desc"
      />
    )

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Manual install'
    )
    expect(
      screen.getByRole('textbox', { name: 'Install command' })
    ).toHaveValue('npm install -g @motrix/cli@latest')
    expect(screen.getByRole('alert')).toHaveTextContent(
      /only in the desktop app/i
    )
  })

  it('keeps the dialog open when the saved magnet association was rejected', async () => {
    const onClose = vi.fn()
    vi.mocked(transport.invoke).mockImplementation(async (channel: string) => {
      if (channel === 'query:getSettings') {
        return {
          app: {
            browserBridgeEnabled: false,
            protocols: { magnet: false },
          },
          media: {
            ffmpegBinaryPath: '',
            ffmpegStagingMB: 1024,
            ffmpegOpTimeoutSec: 300,
          },
        }
      }
      if (channel === 'command:updateSettings') {
        return { ok: true, protocolAssociationApplied: false }
      }
      if (
        channel === 'bridge:listPaired' ||
        channel === 'bridge:listTrusted' ||
        channel === 'bridge:listPendingPairRequests'
      ) {
        return []
      }
      if (channel === 'bridge:getStatus') {
        return bridgeStatus.current
      }
      if (channel === 'query:getFfmpegDetection') {
        return { active: null, candidates: [] }
      }
      if (channel === 'query:getAppImageIntegrationStatus') {
        return { supported: false }
      }
      return {}
    })
    const user = userEvent.setup()
    render(
      <IntegrationDialog
        open={true}
        onClose={onClose}
        labelKey="settings.cards.integration.title"
        descKey="settings.cards.integration.desc"
      />
    )

    await user.click(
      await screen.findByRole('switch', {
        name: 'Open magnet links with Motrix',
      })
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(
      await screen.findByText(/desktop association could not be changed/i)
    ).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('surfaces the degraded-port notice in the browser extensions card when the bridge fell back to an ephemeral port (Task 21)', async () => {
    bridgeStatus.current = {
      port: 54321,
      degraded: true,
      extensionPairingHealth: 'ready',
      fixedPort: 'auto',
      instanceId: 'test-instance',
    }

    render(
      <IntegrationDialog
        open={true}
        onClose={() => {}}
        labelKey="settings.cards.integration.title"
        descKey="settings.cards.integration.desc"
      />
    )

    expect(
      await screen.findByText('Bridge running on a fallback port')
    ).toBeInTheDocument()
    expect(screen.getByText(/bound port 54321 instead/)).toBeInTheDocument()
  })

  it('shows no degraded-port notice when the bridge is running on its normal port', async () => {
    render(
      <IntegrationDialog
        open={true}
        onClose={() => {}}
        labelKey="settings.cards.integration.title"
        descKey="settings.cards.integration.desc"
      />
    )

    await screen.findByRole('heading', { name: /browser extensions/i })
    expect(
      screen.queryByText('Bridge running on a fallback port')
    ).not.toBeInTheDocument()
  })

  it('keeps a projection failure visible and warns that the paired list is incomplete', async () => {
    bridgeStatus.current = {
      port: 16802,
      degraded: false,
      extensionPairingHealth: 'degraded',
      fixedPort: 'auto',
      instanceId: 'test-instance',
    }

    render(
      <IntegrationDialog
        open={true}
        onClose={() => {}}
        labelKey="settings.cards.integration.title"
        descKey="settings.cards.integration.desc"
      />
    )

    expect(
      await screen.findByText('Extension access is temporarily closed')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/do not rely on the list below/i)
    ).toBeInTheDocument()
  })
})
