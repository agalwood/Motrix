import '@renderer/lib/i18n'
import '@test-utils/dom-animations'
import '@testing-library/jest-dom/vitest'
import { transport } from '@renderer/lib/transport'
import {
  BridgeCommands,
  BridgeQueries,
  type PairedClientInfo,
} from '@shared/protocol/bridge'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_APP_SETTINGS, DEFAULT_MEDIA_SETTINGS } from '@shared/schemas'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FormProvider, useForm } from 'react-hook-form'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserExtensionsSection } from './browser-extensions-section'
import type { IntegrationFormValues } from './integration-dialog'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

const PAIRED_EXTENSION: PairedClientInfo = {
  kind: 'extension',
  id: 'test-browser-extension',
  browser: 'chromium',
  name: 'Previously paired extension',
  identityTrust: 'unverified',
  status: 'ready',
  pairedAt: 1,
  lastActiveAt: null,
}
const UNAVAILABLE_TITLE = 'Automatic browser discovery is currently unavailable'

function Harness({ enabled }: { enabled: boolean }) {
  const form = useForm<IntegrationFormValues>({
    defaultValues: {
      app: {
        browserBridgeEnabled: enabled,
        protocols: DEFAULT_APP_SETTINGS.protocols,
      },
      media: { ...DEFAULT_MEDIA_SETTINGS },
    },
  })
  return (
    <FormProvider {...form}>
      <BrowserExtensionsSection />
    </FormProvider>
  )
}

async function renderSection(enabled = true) {
  await act(async () => {
    render(<Harness enabled={enabled} />)
  })
}

describe('BrowserExtensionsSection registration policy', () => {
  let policy: unknown
  let failPolicy: boolean
  let bridgeDisabled: boolean
  let degradedPort: boolean

  beforeEach(() => {
    policy = { mode: 'managed' }
    failPolicy = false
    bridgeDisabled = false
    degradedPort = false
    vi.mocked(transport.invoke).mockReset()
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      switch (channel as string) {
        case Queries.GetNativeMessagingRegistrationPolicy:
          if (failPolicy) throw new Error('Policy query failed')
          return policy
        case BridgeQueries.GetStatus:
          if (bridgeDisabled) throw new Error('Bridge is disabled')
          return {
            port: degradedPort ? 54321 : 16802,
            degraded: degradedPort,
            extensionPairingHealth: 'ready',
            fixedPort: 'auto',
            instanceId: 'test-instance',
          }
        case BridgeQueries.ListPaired:
          return [PAIRED_EXTENSION]
        case BridgeQueries.ListTrusted:
          return []
        case BridgeCommands.RevokePair:
          return undefined
        default:
          throw new Error(`Unexpected query: ${channel}`)
      }
    })
  })

  it('shows the Windows package limitation with the bridge off and keeps the switch and paired list', async () => {
    policy = { mode: 'unsupported', reason: 'windows-package' }
    bridgeDisabled = true
    await renderSection(false)

    expect(screen.getByRole('alert')).toHaveTextContent(UNAVAILABLE_TITLE)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This Windows package does not yet support automatic browser discovery. Turning on browser integration will not install the browser connection component.'
    )
    expect(transport.invoke).toHaveBeenCalledWith(
      Queries.GetNativeMessagingRegistrationPolicy
    )
    expect(
      screen.queryByRole('link', { name: /Chrome/ })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /Firefox/ })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /GitHub/ })
    ).not.toBeInTheDocument()
    expect(screen.getByText(PAIRED_EXTENSION.name)).toBeInTheDocument()
    const masterSwitch = screen.getByRole('switch', {
      name: 'Connect browser extensions',
    })
    expect(masterSwitch).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(masterSwitch)
    expect(masterSwitch).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(UNAVAILABLE_TITLE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled()
  })

  it('keeps revocation available and omits Native Messaging recovery advice for Windows packages', async () => {
    policy = { mode: 'unsupported', reason: 'windows-package' }
    degradedPort = true
    await renderSection()

    expect(screen.getByText(UNAVAILABLE_TITLE)).toBeInTheDocument()
    expect(
      screen.queryByText('Bridge running on a fallback port')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/native host are unaffected/)
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(BridgeCommands.RevokePair, {
        identity: {
          kind: 'extension',
          browser: PAIRED_EXTENSION.browser,
          extensionId: PAIRED_EXTENSION.id,
        },
      })
    )
  })

  it.each([
    { mode: 'managed' },
    { mode: 'external' },
    { mode: 'unsupported', reason: 'server' },
  ])(
    'preserves existing installation and port guidance for %j',
    async (value) => {
      policy = value
      degradedPort = true
      await renderSection()

      expect(screen.queryByText(UNAVAILABLE_TITLE)).not.toBeInTheDocument()
      expect(screen.getByRole('link', { name: /Chrome/ })).toBeInTheDocument()
      expect(
        screen.getByRole('link', { name: /Microsoft Edge/ })
      ).toBeInTheDocument()
      expect(screen.getByRole('link', { name: /Firefox/ })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: /GitHub/ })).toBeInTheDocument()
      expect(
        screen.getByText('Bridge running on a fallback port')
      ).toBeInTheDocument()
    }
  )

  it.each(['malformed', 'failed'])(
    'makes no Windows support claim when the policy query is %s',
    async (failure) => {
      policy = {
        mode: 'unsupported',
        reason: 'windows-package',
        unexpected: true,
      }
      failPolicy = failure === 'failed'
      await renderSection()

      expect(screen.queryByText(UNAVAILABLE_TITLE)).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.getByRole('link', { name: /Chrome/ })).toBeInTheDocument()
      expect(screen.getByRole('switch')).toBeInTheDocument()
    }
  )
})
