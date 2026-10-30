import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import {
  BridgeCommands,
  BridgeEvents,
  BridgeQueries,
  type PairedClientInfo,
} from '@shared/protocol/bridge'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { FormProvider, useForm } from 'react-hook-form'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserExtensionsSection } from './browser-extensions-section'
import type { IntegrationFormValues } from './integration-dialog'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    onConnectionChange: vi.fn(() => () => {}),
  },
}))
vi.mock('@renderer/hooks/use-portable-mode', () => ({
  usePortableMode: () => false,
}))
vi.mock('./browser-extension-installs', () => ({
  BrowserExtensionInstalls: () => null,
}))
vi.mock('./trusted-extensions-section', () => ({
  TrustedExtensionsSection: () => null,
}))

function Wrapper() {
  const form = useForm<IntegrationFormValues>({
    defaultValues: { app: { browserBridgeEnabled: true } },
  })
  return (
    <FormProvider {...form}>
      <BrowserExtensionsSection />
    </FormProvider>
  )
}

describe('browser extension installations', () => {
  let paired: PairedClientInfo[]
  const listeners = new Map<string, () => void>()
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
    listeners.clear()
    vi.clearAllMocks()
    paired = [
      {
        kind: 'extension',
        browser: 'chromium',
        id: 'same-extension',
        name: '',
        pairedAt: 1,
        lastActiveAt: 2,
        identityTrust: 'official',
        status: 'ready',
        installations: [
          { id: 'installation-a', pairedAt: 1, connected: true },
          { id: 'installation-b', pairedAt: 2, connected: true },
        ],
      },
    ]
    vi.mocked(transport.on).mockImplementation((event, listener) => {
      listeners.set(event, listener)
    })
    vi.mocked(transport.off).mockImplementation((event) => {
      listeners.delete(event)
    })
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (String(channel) === BridgeQueries.ListPaired)
        return structuredClone(paired)
      if (String(channel) === BridgeCommands.RevokePair) {
        paired = []
        return undefined
      }
      return null
    })
  })

  it('shows both profiles, refreshes disconnect status, and revokes the entire extension group', async () => {
    render(<Wrapper />)
    expect(await screen.findByText('Browser profile 1')).toBeVisible()
    expect(screen.getByText('Browser profile 2')).toBeVisible()
    expect(screen.getAllByText('Connected')).toHaveLength(2)
    const first = paired[0]
    if (first?.kind !== 'extension' || !first.installations)
      throw new Error('fixture missing')
    first.installations[0].connected = false
    act(() => listeners.get(BridgeEvents.ExtensionSessionsChanged)?.())
    await waitFor(() => {
      expect(
        within(screen.getByText('Browser profile 1').closest('li')!).getByText(
          'Not connected'
        )
      ).toBeVisible()
      expect(
        within(screen.getByText('Browser profile 2').closest('li')!).getByText(
          'Connected'
        )
      ).toBeVisible()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect all' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(BridgeCommands.RevokePair, {
        identity: {
          kind: 'extension',
          browser: 'chromium',
          extensionId: 'same-extension',
        },
      })
    )
    await waitFor(() =>
      expect(screen.queryByText('Browser profile 1')).not.toBeInTheDocument()
    )
  })

  it('still renders paired entries supplied by an older backend without installation summaries', async () => {
    const first = paired[0]
    if (first?.kind !== 'extension') throw new Error('fixture missing')
    delete first.installations
    render(<Wrapper />)
    expect(await screen.findByText('same-extension')).toBeVisible()
    expect(screen.getByRole('button', { name: /^Disconnect$/ })).toBeEnabled()
  })
})
