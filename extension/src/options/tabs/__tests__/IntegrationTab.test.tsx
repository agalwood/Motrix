import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_ENDPOINT_ID } from '@/background/EndpointConfigStore'
import { TooltipProvider } from '@/components/ui/tooltip'
import '@/shared/i18n'
import { IntegrationTab } from '@/options/tabs/IntegrationTab'

interface MessageEnvelope {
  kind: string
  payload: unknown
}

declare const browser: {
  runtime: {
    sendMessage: (env: MessageEnvelope) => Promise<unknown>
    connectNative?: (...args: unknown[]) => unknown
  }
}

const serverA = {
  id: 'server-a',
  name: 'Studio',
  url: 'wss://studio.example',
  revision: 4,
  state: 'ready' as const,
}
const serverB = {
  id: 'server-b',
  name: 'Home',
  url: 'wss://home.example:16800',
  revision: 1,
  state: 'ready' as const,
}

let config = {
  version: 3 as const,
  activeEndpointId: LOCAL_ENDPOINT_ID,
  servers: [serverA, serverB],
  cleanupTombstones: [],
}
let pairing: Record<string, boolean> = {
  [LOCAL_ENDPOINT_ID]: true,
  [serverA.id]: false,
  [serverB.id]: true,
}
let messages: MessageEnvelope[] = []
let connectionState: 'connected' | 'disconnected' | 'bootstrapping' =
  'connected'
let lastError: string | null = null
let lastErrorReason: string | null = null
let pairingCodeState: {
  run: number
  maxRuns: number
  attemptsRemaining: number | null
  deadlineMs: number
} | null = null
let remotePolicy = {
  version: 1 as const,
  authorityKey: 'remote-authority',
  authenticatedInstanceId: 'remote-instance',
  remoteDataBoundaryAcceptedAt: null as number | null,
  allowRequestCredentials: false,
  allowCustomHeaders: false,
  allowPageContent: false,
  allowServerUrlProbe: false,
  allowServerUrlResolve: false,
  allowAutomaticTakeover: false,
}

function messagesOfKind(kind: string): MessageEnvelope[] {
  return messages.filter((message) => message.kind === kind)
}

beforeEach(() => {
  config = {
    version: 3,
    activeEndpointId: LOCAL_ENDPOINT_ID,
    servers: [serverA, serverB],
    cleanupTombstones: [],
  }
  pairing = {
    [LOCAL_ENDPOINT_ID]: true,
    [serverA.id]: false,
    [serverB.id]: true,
  }
  messages = []
  connectionState = 'connected'
  lastError = null
  lastErrorReason = null
  pairingCodeState = null
  remotePolicy = {
    ...remotePolicy,
    remoteDataBoundaryAcceptedAt: null,
    allowRequestCredentials: false,
    allowCustomHeaders: false,
  }
  browser.runtime.sendMessage = vi.fn(async (env) => {
    messages.push(env)
    if (env.kind === 'bg.getEndpointConfig') return config
    if (env.kind === 'bg.activateEndpoint') {
      const { endpointId } = env.payload as { endpointId: string }
      config = { ...config, activeEndpointId: endpointId }
      connectionState = pairing[endpointId] ? 'connected' : 'disconnected'
      return { config }
    }
    if (env.kind === 'bg.addServer') {
      const input = env.payload as { name: string; url: string }
      const server = {
        id: 'server-generated',
        ...input,
        revision: 0,
        state: 'ready' as const,
      }
      config = { ...config, servers: [...config.servers, server] }
      return { config, server }
    }
    if (env.kind === 'bg.updateServer') {
      const payload = env.payload as {
        endpointId: string
        expected: { name: string; url: string; revision: number }
        changes: { name: string; url: string }
      }
      const previous = config.servers.find(
        (server) => server.id === payload.endpointId
      )
      if (
        previous === undefined ||
        previous.name !== payload.expected.name ||
        previous.url !== payload.expected.url ||
        previous.revision !== payload.expected.revision
      ) {
        return { error: 'server changed; refresh and try again' }
      }
      const urlChanged = previous.url !== payload.changes.url
      const server = {
        id: payload.endpointId,
        ...payload.changes,
        revision: urlChanged ? previous.revision + 1 : previous.revision,
        state: 'ready' as const,
      }
      config = {
        ...config,
        servers: config.servers.map((candidate) =>
          candidate.id === payload.endpointId ? server : candidate
        ),
      }
      if (urlChanged) pairing[payload.endpointId] = false
      return {
        config,
        server,
        urlChanged,
        active: config.activeEndpointId === payload.endpointId,
      }
    }
    if (env.kind === 'bg.removeServer') {
      const { endpointId, expected } = env.payload as {
        endpointId: string
        expected: { name: string; url: string; revision: number }
      }
      const previous = config.servers.find((server) => server.id === endpointId)
      if (
        previous === undefined ||
        previous.name !== expected.name ||
        previous.url !== expected.url ||
        previous.revision !== expected.revision
      ) {
        return { error: 'server changed; refresh and try again' }
      }
      const wasActive = config.activeEndpointId === endpointId
      config = {
        ...config,
        activeEndpointId: wasActive
          ? LOCAL_ENDPOINT_ID
          : config.activeEndpointId,
        servers: config.servers.filter((server) => server.id !== endpointId),
      }
      delete pairing[endpointId]
      if (wasActive) connectionState = 'disconnected'
      return { config, wasActive }
    }
    if (env.kind === 'bg.getState') {
      const activeServer = config.servers.find(
        (server) => server.id === config.activeEndpointId
      )
      return {
        state: connectionState,
        ...(connectionState === 'connected'
          ? {
              server:
                activeServer === undefined
                  ? {
                      name: 'Motrix',
                      version: '2.0.0-beta',
                      runtime: 'electron',
                      instanceId: 'local-instance',
                    }
                  : {
                      name: 'Motrix Server',
                      version: '2.0.0-beta',
                      runtime: 'server',
                      instanceId: `${activeServer.id}-instance`,
                    },
            }
          : {}),
        ...(lastError === null ? {} : { lastError }),
        ...(lastErrorReason === null ? {} : { lastErrorReason }),
        ...(pairingCodeState === null ? {} : { pairingCode: pairingCodeState }),
      }
    }
    if (env.kind === 'bg.pairHeartbeat') return { ok: true }
    if (env.kind === 'bg.submitPairingCode') {
      return { ok: false }
    }
    if (env.kind === 'bg.listPairCandidates') {
      return {
        candidates: [{ port: 16802, instanceId: 'i-1', appVersion: '2.0.0' }],
      }
    }
    if (env.kind === 'bg.chooseCandidate') return { ok: true }
    if (env.kind === 'bg.reconnect') {
      connectionState = pairing[config.activeEndpointId]
        ? 'connected'
        : 'disconnected'
      return { ok: true }
    }
    if (env.kind === 'bg.getPairingStatus') {
      const { endpointId } = env.payload as { endpointId: string }
      return { paired: pairing[endpointId] ?? false }
    }
    if (env.kind === 'bg.getRemoteBackendPolicy') {
      return { policy: remotePolicy }
    }
    if (env.kind === 'bg.replaceRemoteBackendPolicy') {
      remotePolicy = { ...remotePolicy, ...(env.payload as object) }
      connectionState = 'connected'
      return { policy: remotePolicy }
    }
    if (env.kind === 'bg.unpair') {
      const { endpointId } = env.payload as { endpointId: string }
      pairing[endpointId] = false
      if (config.activeEndpointId === endpointId) {
        connectionState = 'disconnected'
      }
      return { ok: true }
    }
    throw new Error(`unexpected ${env.kind}`)
  })
})

describe('IntegrationTab', () => {
  it('shows Server-only setup when Native Messaging is unavailable', async () => {
    const connectNative = browser.runtime.connectNative
    browser.runtime.connectNative = undefined

    try {
      render(<IntegrationTab />)
      const backendList = await screen.findByRole('list', {
        name: 'Available Motrix backends',
      })

      expect(within(backendList).queryByText('Motrix App')).toBeNull()
      expect(within(backendList).getAllByRole('listitem')).toHaveLength(2)
      expect(
        await screen.findByRole('heading', {
          level: 2,
          name: 'Pairing Motrix Server',
        })
      ).toBeTruthy()
      expect(screen.getByText('Motrix Server required')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Add server' })).toBeTruthy()
    } finally {
      browser.runtime.connectNative = connectNative
    }
  })

  it('renders backends and pairing as peers without a duplicate tab heading', async () => {
    render(<IntegrationTab />)
    await screen.findByRole('list', { name: 'Available Motrix backends' })

    expect(screen.queryByRole('heading', { name: 'Integration' })).toBeNull()
    const backendHeading = screen.getByRole('heading', {
      level: 2,
      name: 'Motrix backends',
    })
    expect(backendHeading).toBeTruthy()
    expect(backendHeading.parentElement?.className).toContain('gap-1')
    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: 'Pairing Motrix App',
      })
    ).toBeTruthy()
  })

  it('labels an active WS connection without blocking it', async () => {
    const wsServer = { ...serverB, url: 'ws://nas.local:8888/bridge' }
    config = {
      ...config,
      activeEndpointId: wsServer.id,
      servers: [serverA, wsServer],
    }

    render(
      <TooltipProvider>
        <IntegrationTab />
      </TooltipProvider>
    )

    const identityStatus = await screen.findByRole('alert', {
      name: 'Server information',
    })
    expect(identityStatus.textContent).toContain(
      'Server address: ws://nas.local:8888/bridge'
    )
    const securityStatus = within(identityStatus).getByRole('button', {
      name: 'Connection security: encrypted, but WS cannot verify the server identity and may expose connection information. WSS is recommended',
    })
    expect(securityStatus.innerHTML).toContain('lucide-circle-alert')
    securityStatus.focus()
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="tooltip-content"]')
      ).not.toBeNull()
    )
    expect(
      document.querySelector('[data-slot="tooltip-content"]')?.textContent
    ).toContain(
      'Connection security: encrypted, but WS cannot verify the server identity and may expose connection information. WSS is recommended'
    )
    expect(
      within(identityStatus).queryByText(
        /Connection security: encrypted, but WS cannot verify/
      )
    ).toBeNull()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
  })

  it('switches among backends and targets pairing operations to the selected backend', async () => {
    const user = userEvent.setup()
    render(<IntegrationTab />)

    const backendList = await screen.findByRole('list', {
      name: 'Available Motrix backends',
    })
    expect(within(backendList).getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getAllByRole('list')).toHaveLength(1)
    expect(within(backendList).getByText('Motrix App')).toBeTruthy()
    expect(within(backendList).getByText('Studio')).toBeTruthy()
    expect(within(backendList).getByText('Home')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(
      within(backendList)
        .getByText('Motrix App')
        .closest('[role="listitem"]')
        ?.getAttribute('aria-current')
    ).toBe('true')
    expect(
      within(backendList).queryByRole('button', { name: 'Edit Motrix App' })
    ).toBeNull()
    expect(
      within(backendList).queryByRole('button', { name: 'Delete Motrix App' })
    ).toBeNull()
    expect(await screen.findByText('Paired with Motrix')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Forget pairing' }))
    await waitFor(() =>
      expect(messagesOfKind('bg.unpair').at(-1)?.payload).toEqual({
        endpointId: LOCAL_ENDPOINT_ID,
      })
    )

    await user.click(screen.getByRole('button', { name: 'Use Studio' }))
    await waitFor(() =>
      expect(messagesOfKind('bg.activateEndpoint')).toHaveLength(1)
    )
    await screen.findByText(
      'Click Pair, confirm the request in the Server operator UI, then enter the displayed code here. Both WS and WSS endpoints are supported; WSS is recommended.'
    )
    expect(screen.getByRole('button', { name: 'Pair' })).toBeTruthy()
    expect(
      within(backendList)
        .getByText('Studio')
        .closest('[role="listitem"]')
        ?.getAttribute('aria-current')
    ).toBe('true')

    expect(messagesOfKind('bg.activateEndpoint').at(-1)?.payload).toEqual({
      endpointId: serverA.id,
    })
    expect(messagesOfKind('bg.getPairingStatus').at(-1)?.payload).toEqual({
      endpointId: serverA.id,
    })
    expect(messagesOfKind('bg.reconnect')).toHaveLength(0)
    expect(screen.queryByLabelText('Pair token')).toBeNull()
    expect(
      (
        screen.getByRole('button', {
          name: 'Reconnect',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Use Home' }))
    await waitFor(() =>
      expect(messagesOfKind('bg.getPairingStatus').at(-1)?.payload).toEqual({
        endpointId: serverB.id,
      })
    )
    const identityStatus = await screen.findByRole('alert', {
      name: 'Server information',
    })
    expect(identityStatus.textContent).toContain('Home')
    expect(identityStatus.textContent).toContain(
      'Server address: wss://home.example:16800'
    )
    const securityStatus = within(identityStatus).getByRole('button', {
      name: 'Connection security: WSS is in use and TLS verifies the server identity',
    })
    expect(securityStatus.innerHTML).toContain('lucide-shield-check')
    expect(identityStatus.textContent).not.toContain('Server ID:')
    expect(identityStatus.textContent).toContain(
      'Motrix version: Motrix Server 2.0.0-beta'
    )
    await user.click(screen.getByRole('button', { name: 'Forget pairing' }))
    await waitFor(() =>
      expect(messagesOfKind('bg.unpair').at(-1)?.payload).toEqual({
        endpointId: serverB.id,
      })
    )

    expect(
      messagesOfKind('bg.unpair').map((message) => message.payload)
    ).toEqual([{ endpointId: LOCAL_ENDPOINT_ID }, { endpointId: serverB.id }])
    expect(pairing[serverA.id]).toBe(false)
    expect(pairing[serverB.id]).toBe(false)
  })

  it('keeps syncing a newly selected backend until startup finishes', async () => {
    const baseSend = browser.runtime.sendMessage
    browser.runtime.sendMessage = vi.fn(async (env) => {
      const response = await baseSend(env)
      if (env.kind === 'bg.activateEndpoint') {
        connectionState = 'bootstrapping'
        window.setTimeout(() => {
          connectionState = 'connected'
        }, 50)
      }
      return response
    })
    const user = userEvent.setup()
    render(<IntegrationTab />)

    const backendList = await screen.findByRole('list', {
      name: 'Available Motrix backends',
    })
    const homeRow = within(backendList)
      .getByText('Home')
      .closest('[role="listitem"]') as HTMLElement

    await user.click(within(homeRow).getByRole('button', { name: 'Use Home' }))
    await waitFor(() =>
      expect(within(homeRow).getByText('Starting')).toBeTruthy()
    )
    await waitFor(
      () => expect(within(homeRow).getByText('Connected')).toBeTruthy(),
      { timeout: 2_500 }
    )
    expect(messagesOfKind('bg.getState').length).toBeGreaterThan(2)
  })

  it('starts one explicit remote pairing attempt even under StrictMode', async () => {
    config = { ...config, activeEndpointId: serverA.id }
    connectionState = 'disconnected'
    const user = userEvent.setup()
    render(
      <StrictMode>
        <IntegrationTab />
      </StrictMode>
    )

    const serverInformation = await screen.findByRole('alert', {
      name: 'Server information',
    })
    expect(serverInformation.textContent).not.toContain('Server ID:')
    expect(serverInformation.textContent).not.toContain('Motrix version:')

    await user.click(await screen.findByRole('button', { name: 'Pair' }))
    await waitFor(() => expect(messagesOfKind('bg.reconnect')).toHaveLength(1))
    expect(messagesOfKind('bg.listPairCandidates')).toHaveLength(0)
  })

  it('requires explicit remote data consent and keeps sensitive grants off', async () => {
    config = { ...config, activeEndpointId: serverA.id }
    pairing[serverA.id] = true
    connectionState = 'connected'
    const user = userEvent.setup()
    render(<IntegrationTab />)

    const serverInformation = await screen.findByRole('alert', {
      name: 'Server information',
    })
    expect(serverInformation.textContent).toContain(
      'Motrix version: Motrix Server 2.0.0-beta'
    )
    expect(serverInformation.textContent).toContain(
      'Remote downloads send the target URL'
    )
    const allow = within(serverInformation).getByRole('switch', {
      name: 'Remote downloads',
    })
    const remoteDownloadLabel = within(serverInformation).getByText(
      'Remote downloads'
    ) as HTMLLabelElement
    expect(remoteDownloadLabel.control).not.toBeNull()
    expect(
      remoteDownloadLabel.closest('[data-slot="alert-action"]')?.className
    ).toContain('top-4')
    expect(serverInformation.className).toContain('gap-y-1')
    await waitFor(() => expect(allow.hasAttribute('data-disabled')).toBe(false))
    expect(allow.getAttribute('aria-checked')).toBe('false')
    expect(messagesOfKind('bg.replaceRemoteBackendPolicy')).toHaveLength(0)
    await user.click(allow)

    await waitFor(() =>
      expect(messagesOfKind('bg.replaceRemoteBackendPolicy')).toHaveLength(1)
    )
    expect(
      messagesOfKind('bg.replaceRemoteBackendPolicy')[0]?.payload
    ).toMatchObject({
      remoteDataBoundaryAcceptedAt: expect.any(Number),
      allowCustomHeaders: false,
      allowRequestCredentials: false,
      allowPageContent: false,
      allowServerUrlProbe: false,
      allowServerUrlResolve: false,
      allowAutomaticTakeover: false,
    })
    expect(allow.getAttribute('aria-checked')).toBe('true')
    expect(
      (
        await screen.findByRole('switch', { name: 'Send request headers' })
      ).getAttribute('aria-checked')
    ).toBe('false')
    expect(messagesOfKind('bg.getState')).toHaveLength(2)
    expect(
      screen
        .getByRole('switch', {
          name: 'Send cookies and authentication',
        })
        .hasAttribute('data-disabled')
    ).toBe(true)
  })

  it('keeps connection actions visually stable while remote policy saves', async () => {
    config = { ...config, activeEndpointId: serverA.id }
    pairing[serverA.id] = true
    connectionState = 'connected'
    const baseSend = browser.runtime.sendMessage
    let finishPolicySave!: () => void
    const policySave = new Promise<void>((resolve) => {
      finishPolicySave = resolve
    })
    browser.runtime.sendMessage = vi.fn(async (env) => {
      if (env.kind !== 'bg.replaceRemoteBackendPolicy') {
        return baseSend(env)
      }
      messages.push(env)
      await policySave
      remotePolicy = { ...remotePolicy, ...(env.payload as object) }
      return { policy: remotePolicy }
    })
    const user = userEvent.setup()
    render(<IntegrationTab />)

    const remoteDownloadSwitch = await screen.findByRole('switch', {
      name: 'Remote downloads',
    })
    await waitFor(() =>
      expect(remoteDownloadSwitch.hasAttribute('data-disabled')).toBe(false)
    )
    const reconnect = screen.getByRole('button', {
      name: 'Reconnect',
    }) as HTMLButtonElement
    const forget = screen.getByRole('button', {
      name: 'Forget pairing',
    }) as HTMLButtonElement

    await user.click(remoteDownloadSwitch)
    await waitFor(() =>
      expect(messagesOfKind('bg.replaceRemoteBackendPolicy')).toHaveLength(1)
    )
    await waitFor(() =>
      expect(remoteDownloadSwitch.hasAttribute('data-disabled')).toBe(true)
    )
    expect(reconnect.disabled).toBe(false)
    expect(forget.disabled).toBe(false)
    expect(
      within(reconnect).queryByRole('status', { name: 'Loading' })
    ).toBeNull()

    finishPolicySave()
    await waitFor(() =>
      expect(remoteDownloadSwitch.getAttribute('aria-checked')).toBe('true')
    )
  })

  it('explains why remote download permissions cannot change while offline', async () => {
    config = { ...config, activeEndpointId: serverA.id }
    pairing[serverA.id] = true
    connectionState = 'disconnected'
    render(<IntegrationTab />)

    const serverInformation = await screen.findByRole('alert', {
      name: 'Server information',
    })
    expect(
      within(serverInformation).getByText(
        'Data permissions are bound to the authenticated Server. Connect before changing them.'
      )
    ).toBeTruthy()
    expect(
      within(serverInformation)
        .getByRole('switch', { name: 'Remote downloads' })
        .hasAttribute('data-disabled')
    ).toBe(true)
  })

  it('allows a WS server while showing a non-blocking transport warning', async () => {
    const user = userEvent.setup()
    render(<IntegrationTab />)
    await screen.findByRole('list', { name: 'Available Motrix backends' })

    await user.click(screen.getByRole('button', { name: 'Add server' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Add Motrix Server',
    })
    await user.type(within(dialog).getByLabelText('Server name'), 'Office')
    await user.type(
      within(dialog).getByLabelText('WebSocket URL'),
      'ws://office.example:80/bridge/'
    )
    expect(
      within(dialog).getByRole('alert', {
        name: 'This connection does not use WSS',
      }).textContent
    ).toContain('Content exchanged with Motrix is still encrypted')
    await user.click(
      within(dialog).getByRole('button', { name: 'Save server' })
    )

    await waitFor(() =>
      expect(messagesOfKind('bg.addServer').at(-1)?.payload).toEqual({
        name: 'Office',
        url: 'ws://office.example/bridge',
      })
    )
    expect(screen.getByText('Office')).toBeTruthy()
    expect(config.servers.at(-1)).toEqual({
      id: 'server-generated',
      name: 'Office',
      url: 'ws://office.example/bridge',
      revision: 0,
      state: 'ready',
    })
    expect(messagesOfKind('bg.reconnect')).toHaveLength(0)
  })

  it('atomically updates an active server URL and lets the background reconnect', async () => {
    const user = userEvent.setup()
    config = { ...config, activeEndpointId: serverA.id }
    pairing[serverA.id] = true
    render(<IntegrationTab />)
    await screen.findByRole('list', { name: 'Available Motrix backends' })

    await user.click(
      screen.getByRole('button', { name: `Edit ${serverA.name}` })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Edit Motrix Server',
    })
    const urlInput = within(dialog).getByLabelText('WebSocket URL')
    await user.clear(urlInput)
    await user.type(urlInput, 'wss://new-studio.example')
    await user.click(
      within(dialog).getByRole('button', { name: 'Save server' })
    )

    await waitFor(() =>
      expect(messagesOfKind('bg.updateServer')).toHaveLength(1)
    )
    expect(messagesOfKind('bg.updateServer').at(-1)?.payload).toEqual({
      endpointId: serverA.id,
      expected: {
        name: serverA.name,
        url: serverA.url,
        revision: serverA.revision,
      },
      changes: {
        name: serverA.name,
        url: 'wss://new-studio.example',
      },
    })
    expect(messagesOfKind('bg.unpair')).toHaveLength(0)
    expect(messagesOfKind('bg.reconnect')).toHaveLength(0)
    expect(config.servers[0]?.url).toBe('wss://new-studio.example')
    expect(config.servers[0]?.revision).toBe(serverA.revision + 1)
    expect(config.servers[0]?.state).toBe('ready')
    expect(messagesOfKind('bg.getPairingStatus').at(-1)?.payload).toEqual({
      endpointId: serverA.id,
    })
  })

  it('sends the expected revision and preserves it for a name-only edit', async () => {
    const user = userEvent.setup()
    render(<IntegrationTab />)
    await screen.findByRole('list', { name: 'Available Motrix backends' })

    await user.click(
      screen.getByRole('button', { name: `Edit ${serverA.name}` })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Edit Motrix Server',
    })
    const nameInput = within(dialog).getByLabelText('Server name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Studio renamed')
    await user.click(
      within(dialog).getByRole('button', { name: 'Save server' })
    )

    await waitFor(() =>
      expect(messagesOfKind('bg.updateServer')).toHaveLength(1)
    )
    expect(messagesOfKind('bg.updateServer').at(-1)?.payload).toEqual({
      endpointId: serverA.id,
      expected: {
        name: serverA.name,
        url: serverA.url,
        revision: serverA.revision,
      },
      changes: { name: 'Studio renamed', url: serverA.url },
    })
    expect(config.servers[0]).toMatchObject({
      name: 'Studio renamed',
      revision: serverA.revision,
      state: 'ready',
    })
  })

  it('atomically deletes an active server and uses the returned local fallback', async () => {
    const user = userEvent.setup()
    config = {
      ...config,
      activeEndpointId: serverA.id,
      servers: [serverA],
    }
    pairing[serverA.id] = true
    render(<IntegrationTab />)
    const backendList = await screen.findByRole('list', {
      name: 'Available Motrix backends',
    })

    await user.click(
      screen.getByRole('button', { name: `Delete ${serverA.name}` })
    )
    const alert = await screen.findByRole('alertdialog', {
      name: 'Delete Motrix Server?',
    })
    expect(
      within(alert).getByText(/fall back to Motrix App without connecting/i)
    ).toBeTruthy()
    await user.click(
      within(alert).getByRole('button', { name: 'Delete server' })
    )

    await waitFor(() =>
      expect(messagesOfKind('bg.removeServer')).toHaveLength(1)
    )
    expect(messagesOfKind('bg.removeServer').at(-1)?.payload).toEqual({
      endpointId: serverA.id,
      expected: {
        name: serverA.name,
        url: serverA.url,
        revision: serverA.revision,
      },
    })
    expect(messagesOfKind('bg.unpair')).toHaveLength(0)
    expect(messagesOfKind('bg.reconnect')).toHaveLength(0)
    expect(config.activeEndpointId).toBe(LOCAL_ENDPOINT_ID)
    expect(config.servers).toEqual([])
    expect(await screen.findByText('Disconnected')).toBeTruthy()
    expect(screen.queryByText('Starting')).toBeNull()
    expect(messagesOfKind('bg.getPairingStatus').at(-1)?.payload).toEqual({
      endpointId: LOCAL_ENDPOINT_ID,
    })
    await waitFor(() =>
      expect(within(backendList).getAllByRole('listitem')).toHaveLength(1)
    )
    expect(within(backendList).getByText('Motrix App')).toBeTruthy()
    expect(screen.getByText('No Motrix Servers yet')).toBeTruthy()
  })

  it('deletes an inactive server without changing current connection or pairing state', async () => {
    const user = userEvent.setup()
    render(<IntegrationTab />)
    const backendList = await screen.findByRole('list', {
      name: 'Available Motrix backends',
    })
    expect(await screen.findByText('Connected')).toBeTruthy()

    await user.click(
      screen.getByRole('button', { name: `Delete ${serverA.name}` })
    )
    const alert = await screen.findByRole('alertdialog', {
      name: 'Delete Motrix Server?',
    })
    expect(
      within(alert).getByText(/does not revoke anything on the server/i)
    ).toBeTruthy()
    await user.click(
      within(alert).getByRole('button', { name: 'Delete server' })
    )

    await waitFor(() =>
      expect(messagesOfKind('bg.removeServer')).toHaveLength(1)
    )
    expect(config.activeEndpointId).toBe(LOCAL_ENDPOINT_ID)
    expect(config.servers).toEqual([serverB])
    expect(connectionState).toBe('connected')
    expect(messagesOfKind('bg.getState')).toHaveLength(1)
    expect(messagesOfKind('bg.getPairingStatus')).toHaveLength(1)
    expect(within(backendList).getByText('Motrix App')).toBeTruthy()
    expect(within(backendList).queryByText('Studio')).toBeNull()
    expect(await screen.findByText('Connected')).toBeTruthy()
  })

  it('reloads the latest catalogue after an update CAS conflict', async () => {
    const user = userEvent.setup()
    render(<IntegrationTab />)
    await screen.findByRole('list', { name: 'Available Motrix backends' })

    await user.click(
      screen.getByRole('button', { name: `Edit ${serverA.name}` })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Edit Motrix Server',
    })
    const nameInput = within(dialog).getByLabelText('Server name')
    await user.clear(nameInput)
    await user.type(nameInput, 'My stale edit')

    const baseSend = browser.runtime.sendMessage
    browser.runtime.sendMessage = vi.fn(async (env) => {
      if (env.kind === 'bg.updateServer') {
        messages.push(env)
        config = {
          ...config,
          servers: config.servers.map((server) =>
            server.id === serverA.id
              ? { ...server, name: 'Studio from another tab' }
              : server
          ),
        }
        return { error: 'server changed; refresh and try again' }
      }
      return baseSend(env)
    })

    await user.click(
      within(dialog).getByRole('button', { name: 'Save server' })
    )
    await screen.findByText('server changed; refresh and try again')
    await waitFor(() =>
      expect(messagesOfKind('bg.getEndpointConfig')).toHaveLength(2)
    )

    // The icon-only dismiss button also has a localized Cancel label.
    await user.click(within(dialog).getByText('Cancel', { selector: 'button' }))
    expect(await screen.findByText('Studio from another tab')).toBeTruthy()
    expect(config.servers[0]?.name).toBe('Studio from another tab')
  })
  it('shows localized copy, not the raw sentence, when pairing is rate-limited', async () => {
    connectionState = 'disconnected'
    pairing = { ...pairing, [LOCAL_ENDPOINT_ID]: false }
    const user = userEvent.setup()
    render(<IntegrationTab />)

    const pairButton = await screen.findByRole('button', { name: 'Pair' })
    // Disabled until the endpoint config loads; a click before that is a
    // silent no-op.
    await waitFor(() =>
      expect((pairButton as HTMLButtonElement).disabled).toBe(false)
    )
    await user.click(pairButton)
    // The single candidate auto-chooses; the attempt then fails under the
    // §7.3 backoff, which bg.getState reports as a reason code.
    lastError = 'first-pair backoff is active; try again later'
    lastErrorReason = 'backoffLocked'

    expect(
      await screen.findByText(
        'Too many pairing attempts. Try again later.',
        undefined,
        { timeout: 4000 }
      )
    ).toBeTruthy()
    expect(
      screen.queryByText('first-pair backoff is active; try again later')
    ).toBeNull()
  })

  it.each([
    [
      'backendUpgradeRequired',
      'This Motrix version is too old for secure pairing. Update Motrix, then try again.',
    ],
    [
      'extensionUpgradeRequired',
      'This extension version is too old for this Motrix. Update the Motrix extension, then try again.',
    ],
    [
      'unsupportedRemote',
      'The authenticated Motrix is not the App or Server selected for this connection. Check the endpoint and try again.',
    ],
  ])(
    'shows the %s compatibility action in the pairing dialog',
    async (reason, copy) => {
      connectionState = 'disconnected'
      pairing = { ...pairing, [LOCAL_ENDPOINT_ID]: false }
      const user = userEvent.setup()
      render(<IntegrationTab />)

      const pairButton = await screen.findByRole('button', { name: 'Pair' })
      await waitFor(() =>
        expect((pairButton as HTMLButtonElement).disabled).toBe(false)
      )
      await user.click(pairButton)
      lastError = `developer-only: ${reason}`
      lastErrorReason = reason

      expect(
        await screen.findByText(copy, undefined, { timeout: 4000 })
      ).toBeTruthy()
      expect(screen.queryByText(`developer-only: ${reason}`)).toBeNull()
    }
  )

  it('drops a stale failure banner once a live pairing prompt arrives', async () => {
    connectionState = 'disconnected'
    pairing = { ...pairing, [LOCAL_ENDPOINT_ID]: false }
    const user = userEvent.setup()
    render(<IntegrationTab />)

    const pairButton = await screen.findByRole('button', { name: 'Pair' })
    await waitFor(() =>
      expect((pairButton as HTMLButtonElement).disabled).toBe(false)
    )
    await user.click(pairButton)
    lastError = 'first-pair backoff is active; try again later'
    lastErrorReason = 'backoffLocked'
    await screen.findByText(
      'Too many pairing attempts. Try again later.',
      undefined,
      { timeout: 4000 }
    )

    // A new attempt got through and its prompt is live — even while the
    // stale error fields still linger, the dialog must not show a dead
    // attempt's failure beside a living attempt's prompt.
    pairingCodeState = {
      run: 1,
      maxRuns: 3,
      attemptsRemaining: null,
      deadlineMs: Date.now() + 120_000,
    }
    const dialog = await screen.findByRole('dialog', {
      name: 'Pair with Motrix',
    })
    await within(dialog).findByRole('textbox', undefined, { timeout: 4000 })
    await waitFor(() =>
      expect(
        screen.queryByText('Too many pairing attempts. Try again later.')
      ).toBeNull()
    )
  })

  it('localizes a declined code submission instead of echoing the bus error', async () => {
    connectionState = 'disconnected'
    pairing = { ...pairing, [LOCAL_ENDPOINT_ID]: false }
    const user = userEvent.setup()
    render(<IntegrationTab />)

    const pairButton = await screen.findByRole('button', { name: 'Pair' })
    await waitFor(() =>
      expect((pairButton as HTMLButtonElement).disabled).toBe(false)
    )
    await user.click(pairButton)
    // The prompt appears via the poll, then evaporates server-side before
    // the user submits — bg.submitPairingCode answers ok:false.
    pairingCodeState = {
      run: 1,
      maxRuns: 3,
      attemptsRemaining: null,
      deadlineMs: Date.now() + 120_000,
    }
    const dialog = await screen.findByRole('dialog', {
      name: 'Pair with Motrix',
    })
    const codeInput = (await within(dialog).findByRole('textbox', undefined, {
      timeout: 4000,
    })) as HTMLInputElement
    await user.type(codeInput, 'MTX7K2Q9')
    await user.click(within(dialog).getByRole('button', { name: 'Pair' }))
    await waitFor(() =>
      expect(messagesOfKind('bg.submitPairingCode')).toHaveLength(1)
    )

    expect(
      await screen.findByText('The attempt timed out. Try again.')
    ).toBeTruthy()
    expect(screen.queryByText('no pairing code request is pending')).toBeNull()
  })
})

it('opens App pairing from a takeover action after activating the App', async () => {
  config = { ...config, activeEndpointId: serverA.id }
  const handled = vi.fn()
  render(
    <IntegrationTab pairingAction="pair-app" onPairingActionHandled={handled} />
  )
  await waitFor(() =>
    expect(messagesOfKind('bg.listPairCandidates')).toHaveLength(1)
  )
  expect(config.activeEndpointId).toBe('local')
  expect(handled).toHaveBeenCalledTimes(1)
})

it('adds, activates and pairs a Server from a takeover action', async () => {
  const user = userEvent.setup()
  render(<IntegrationTab pairingAction="add-server" />)
  const dialog = await screen.findByRole('dialog')
  await user.type(
    within(dialog).getByRole('textbox', { name: 'Server name' }),
    'New Server'
  )
  await user.type(
    within(dialog).getByRole('textbox', { name: 'WebSocket URL' }),
    'wss://new.example'
  )
  await user.click(within(dialog).getByRole('button', { name: 'Save server' }))
  await waitFor(() => expect(messagesOfKind('bg.reconnect')).toHaveLength(1))
  const added = config.servers.find((server) => server.name === 'New Server')
  expect(added).toBeDefined()
  expect(config.activeEndpointId).toBe(added?.id)
  expect(messagesOfKind('bg.listPairCandidates')).toHaveLength(0)
})
