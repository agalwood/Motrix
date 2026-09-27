import { DEFAULT_APP_SETTINGS, DEFAULT_MEDIA_SETTINGS } from '@shared/schemas'
import '@test-utils/dom-animations'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { toast } from '@renderer/components/ui/toast'
import { BridgeCommands, BridgeQueries } from '@shared/protocol/bridge'
import { Queries } from '@shared/protocol/queries'
import {
  CliInstallCapability,
  CliPackageManager,
  CliToolPhase,
  CliToolReason,
} from '@shared/types/cli-tool'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: vi.fn(), close: vi.fn() },
}))

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
      if (channel === 'query:getSettings')
        return Promise.resolve({
          app: DEFAULT_APP_SETTINGS,
          media: DEFAULT_MEDIA_SETTINGS,
        })
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

const defaultInvoke = vi.mocked(transport.invoke).getMockImplementation()!

describe('IntegrationDialog scaffold', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockImplementation(defaultInvoke).mockClear()
    transport.platform = 'darwin'
    bridgeStatus.current = {
      port: 16802,
      degraded: false,
      extensionPairingHealth: 'ready',
      fixedPort: 'auto',
      instanceId: 'test-instance',
    }
  })

  it('shares the unsupported CLI status without hiding pairing, approvals, or revocation', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel, ...args) => {
      if (channel === Queries.GetCliToolStatus) {
        return {
          phase: CliToolPhase.Unsupported,
          capability: CliInstallCapability.Unsupported,
          installCommand: '',
          packageManager: CliPackageManager.Unknown,
          managerOptions: [],
          version: null,
          executablePath: null,
          nodeVersion: null,
          reason: CliToolReason.WindowsPackage,
          detail: null,
        }
      }
      if ((channel as string) === BridgeQueries.ListPaired) {
        return [
          {
            kind: 'cli',
            id: 'paired-cli',
            name: 'Previously paired tool',
            pairedAt: 1,
            lastActiveAt: null,
          },
        ]
      }
      if ((channel as string) === BridgeQueries.ListPendingPairRequests) {
        return [
          {
            kind: 'cli',
            requestId: 'pending-cli',
            userCode: 'WXYZ-2345',
            clientName: 'Pending tool',
            clientVersion: '0.5.0',
            createdAt: Date.now(),
            expiresAt: Date.now() + 300_000,
          },
        ]
      }
      return defaultInvoke(channel, ...args)
    })
    render(
      <IntegrationDialog
        open
        onClose={() => {}}
        labelKey="settings.cards.integration.title"
        descKey="settings.cards.integration.desc"
      />
    )

    expect(
      await screen.findByText(
        /This Windows package does not yet support automatic CLI discovery/
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText('Manage tools paired with this app here.')
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Local tools connect automatically/)
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Run motrix in a terminal to control this app/)
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('textbox', { name: 'Install command' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Copy install command' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('Previously paired tool')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(BridgeCommands.RevokePair, {
        identity: { kind: 'cli', id: 'paired-cli' },
      })
    )
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(([channel]) => channel === Queries.GetCliToolStatus)
    ).toHaveLength(1)
  })

  it('queries the shared CLI status only while dialog content is mounted and refreshes on reopen', async () => {
    const props = {
      onClose: () => {},
      labelKey: 'settings.cards.integration.title',
      descKey: 'settings.cards.integration.desc',
    }
    const view = render(<IntegrationDialog {...props} open={false} />)
    await act(async () => {})
    const cliQueries = () =>
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(([channel]) => channel === Queries.GetCliToolStatus)
    expect(cliQueries()).toHaveLength(0)

    view.rerender(<IntegrationDialog {...props} open />)
    await screen.findByText('Manual install')
    expect(cliQueries()).toHaveLength(1)

    view.rerender(<IntegrationDialog {...props} open={false} />)
    await waitFor(() =>
      expect(
        screen.queryByText('Motrix command-line tool')
      ).not.toBeInTheDocument()
    )
    expect(cliQueries()).toHaveLength(1)
    view.rerender(<IntegrationDialog {...props} open />)
    await screen.findByText('Manual install')
    expect(cliQueries()).toHaveLength(2)
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
      await screen.findByRole('heading', { name: /default app/i })
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
      screen.queryByRole('heading', { name: /default app/i })
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
    expect(
      screen.getByText(/Run motrix in a terminal to control this app/i)
    ).toBeTruthy()
  })

  it('preserves manual-only installation guidance in the web client', async () => {
    transport.platform = 'web'
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
    expect(
      screen.getByText(/Local tools connect automatically/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/This Windows package/)).not.toBeInTheDocument()
  })

  it.each([true, false])(
    'shows the plugin restart reminder only after a successful FFmpeg save (%s)',
    async (saved) => {
      const original = vi.mocked(transport.invoke).getMockImplementation()!
      vi.mocked(transport.invoke).mockImplementation(
        async (channel, ...args) => {
          if (channel === 'command:updateSettings') {
            if (!saved) throw new Error('Save failed')
            return { saved: true }
          }
          return original(channel, ...args)
        }
      )
      const onClose = vi.fn()
      try {
        render(
          <IntegrationDialog
            open
            onClose={onClose}
            labelKey="settings.cards.integration.title"
            descKey="settings.cards.integration.desc"
          />
        )
        fireEvent.click(
          await screen.findByRole('button', { name: 'Show detection details' })
        )
        fireEvent.click(
          screen.getByRole('button', { name: 'Edit custom FFmpeg path' })
        )
        fireEvent.change(
          screen.getByRole('textbox', { name: 'Custom FFmpeg path' }),
          { target: { value: '/configured/ffmpeg' } }
        )
        expect(toast.add).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() =>
          expect(transport.invoke).toHaveBeenCalledWith(
            'command:updateSettings',
            { media: { ffmpegBinaryPath: '/configured/ffmpeg' } }
          )
        )
        if (saved) {
          await waitFor(() =>
            expect(toast.add).toHaveBeenCalledWith(
              expect.objectContaining({
                title: 'FFmpeg settings saved',
                description: expect.stringContaining(
                  'Restart Motrix for active plugins'
                ),
                timeout: 0,
              })
            )
          )
          expect(onClose).toHaveBeenCalled()
        } else {
          await screen.findByText('Couldn’t save your changes. Try again.')
          expect(toast.add).not.toHaveBeenCalled()
          expect(onClose).not.toHaveBeenCalled()
        }
      } finally {
        vi.mocked(transport.invoke).mockImplementation(original)
      }
    }
  )

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
        return { saved: true, protocolAssociationApplied: false }
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
      if (channel === 'query:getSettings')
        return Promise.resolve({
          app: DEFAULT_APP_SETTINGS,
          media: DEFAULT_MEDIA_SETTINGS,
        })
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
