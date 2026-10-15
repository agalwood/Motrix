import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/popup/App'
import { i18n } from '@/shared/i18n'
import { defaultTaskOptions } from '@/shared/taskOptions'

declare const browser: {
  runtime: {
    sendMessage: (msg: unknown) => Promise<unknown>
    openOptionsPage: () => Promise<void>
    connectNative?: (...args: unknown[]) => unknown
  }
}

type Envelope = { kind: string; payload: unknown }

const TASK = {
  id: 'task-1',
  type: 'http',
  name: 'ubuntu.iso',
  status: 'downloading',
  progress: 0.5,
  bytesDone: 512,
  bytesTotal: 1024,
  speedBps: 2048,
  etaSec: 30,
  saveDir: '/downloads',
  error: null,
  createdAt: 1,
  finishedAt: null,
  finalPath: null,
}

const MEDIA_ITEM = {
  kind: 'mux' as const,
  url: 'https://media.example/video.mp4',
  pageUrl: 'https://media.example/watch',
  pageTitle: 'Example video',
  detectedAt: 1,
}

const SERVERS = [
  {
    id: 'studio',
    name: 'Studio Server',
    url: 'wss://studio.example/ws',
    revision: 2,
    state: 'ready' as const,
  },
  {
    id: 'nas',
    name: 'Home NAS',
    url: 'wss://nas.example:16800',
    revision: 0,
    state: 'ready' as const,
  },
]

const LOCAL_ENDPOINT = {
  version: 3 as const,
  activeEndpointId: 'local',
  servers: SERVERS,
  cleanupTombstones: [],
}

const SNAPSHOT = {
  endpoint: LOCAL_ENDPOINT,
  pairing: 'stored',
  phase: 'idle',
  attemptIntent: null,
}

function installConnectedBus(): ReturnType<typeof vi.fn> {
  let endpoint = LOCAL_ENDPOINT
  const sendMessage = vi.fn(async (msg: unknown) => {
    const env = msg as Envelope
    if (env.kind === 'bg.getState') {
      return {
        ...SNAPSHOT,
        endpoint,
        phase: 'ready',
        state: 'connected',
        capabilities: { taskReveal: true },
        server: {
          name: 'Motrix',
          version: '2.0.0',
          runtime: 'electron',
        },
      }
    }
    if (env.kind === 'bg.hasPairedBackend') return { paired: true }
    if (env.kind === 'bg.getEndpointConfig') {
      return endpoint
    }
    if (env.kind === 'bg.activateEndpoint') {
      endpoint = {
        ...endpoint,
        activeEndpointId: (env.payload as { endpointId: string }).endpointId,
      }
      return { config: endpoint }
    }
    if (env.kind === 'bg.taskList') return { tasks: [TASK], total: 1 }
    if (env.kind === 'bg.statsGet') {
      return {
        totalDownloadSpeed: 1024 * 1024,
        totalUploadSpeed: 2048,
        activeTasks: 1,
        waitingTasks: 0,
        stoppedTasks: 0,
      }
    }
    if (env.kind === 'bg.engineStatus') {
      return { state: 'ready', featureReport: null }
    }
    if (env.kind === 'bg.createManualTask') {
      return { taskId: 'task-created' }
    }
    if (env.kind === 'bg.scanActiveTab') {
      return { media: [], selectionKinds: ['direct'] }
    }
    if (env.kind === 'bg.getTakeoverConfig') {
      return {
        enabled: true,
        consentAckVersion: 1,
        defaultAction: 'motrix',
        rules: [],
      }
    }
    if (env.kind === 'bg.getNotificationsConfig') {
      return { master: true, confirm: false, error: true, reminder: true }
    }
    return { ok: true }
  })
  browser.runtime.sendMessage = sendMessage
  return sendMessage
}

describe('Popup App', () => {
  beforeEach(async () => {
    vi.useRealTimers()
    await i18n.changeLanguage('en-US')
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await i18n.changeLanguage('en-US')
  })

  it('shows Safari offline resources without presenting send or connection actions', async () => {
    vi.stubGlobal('__BROWSER__', 'safari')
    const sendMessage = installConnectedBus()
    render(<App />)
    expect(
      await screen.findByRole('heading', {
        name: i18n.t('popup.sniffer.pageResources'),
      })
    ).toBeTruthy()
    expect(screen.queryByText(i18n.t('safari.previewTitle'))).toBeNull()
    expect(screen.queryByText(i18n.t('safari.previewHelp'))).toBeNull()
    expect(screen.queryByTestId('dashboard-tiles')).toBeNull()
    expect(
      screen.queryByRole('tab', { name: i18n.t('popup.tabs.tasks') })
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: i18n.t('popup.sniffer.downloadSelected'),
      })
    ).toBeNull()
    expect(screen.queryByTestId('takeover-switch')).toBeNull()
    expect(
      sendMessage.mock.calls.some(([message]) =>
        [
          'bg.reconnect',
          'bg.listPairCandidates',
          'bg.submitMedia',
          'bg.taskList',
        ].includes((message as Envelope).kind)
      )
    ).toBe(false)
  })

  it('renders the connected App backend, speed tiles, and active tasks', async () => {
    installConnectedBus()

    render(<App />)

    expect(await screen.findByText('Motrix App')).toBeTruthy()
    expect(await screen.findByText('ubuntu.iso')).toBeTruthy()
    expect(screen.getByTestId('task-reveal-task-1')).toBeTruthy()
    expect(
      screen
        .getByRole('link', {
          name: 'View task details in Motrix App: ubuntu.iso',
        })
        .getAttribute('href')
    ).toBe('motrix://tasks/task-1')

    const popup = screen.getByTestId('compact-popup')
    expect(popup.className).toContain('h-[600px]')
    expect(popup.className).toContain('w-[400px]')
    expect(screen.getByTestId('dashboard-tiles').className).toContain(
      'grid-cols-4'
    )

    const upload = screen.getByRole('group', { name: 'Upload' })
    expect(within(upload).getByText('2.0')).toBeTruthy()
    expect(within(upload).getByText('KB/s')).toBeTruthy()

    const download = screen.getByRole('group', { name: 'Download' })
    expect(within(download).getByText('1.0')).toBeTruthy()
    expect(within(download).getByText('MB/s')).toBeTruthy()
  })

  it('renders structured connection failures through the production status panel', async () => {
    const rawError = 'backend capability check failed: apiVersion=1'
    browser.runtime.sendMessage = vi.fn(async (msg: unknown) => {
      const env = msg as Envelope
      if (env.kind === 'bg.getState') {
        return {
          ...SNAPSHOT,
          state: 'disconnected',
          lastError: rawError,
          lastErrorReason: 'backendUpgradeRequired',
        }
      }
      if (env.kind === 'bg.hasPairedBackend') return { paired: true }
      if (env.kind === 'bg.getEndpointConfig') {
        return LOCAL_ENDPOINT
      }
      return { ok: true }
    })

    render(<App />)

    expect(
      await screen.findByText(
        i18n.t('errors.connection.backendUpgradeRequired')
      )
    ).toBeTruthy()
    expect(screen.queryByText(rawError)).toBeNull()
    expect(
      screen.getByRole('button', { name: i18n.t('popup.reconnect') })
    ).toBeTruthy()
  })

  it('shows the pairing code panel and submits the code when a code is pending — H2c', async () => {
    const sendMessage = vi.fn(async (msg: unknown) => {
      const env = msg as Envelope
      if (env.kind === 'bg.getState') {
        return {
          ...SNAPSHOT,
          state: 'handshaking',
          pairingCode: {
            instanceId: 'motrix-desktop-1',
            run: 1,
            maxRuns: 3,
            attemptsRemaining: null,
            deadlineMs: Date.now() + 60_000,
          },
        }
      }
      if (env.kind === 'bg.hasPairedBackend') return { paired: true }
      if (env.kind === 'bg.getEndpointConfig') {
        return LOCAL_ENDPOINT
      }
      if (env.kind === 'bg.submitPairingCode') return { ok: true }
      return { ok: true }
    })
    browser.runtime.sendMessage = sendMessage
    const user = userEvent.setup()

    render(<App />)

    const input = await screen.findByRole('textbox')
    // The production prompt uses the compact dialog while the normal popup
    // remains visible behind it, matching the selected prototype.
    expect(
      screen.getByRole('dialog', { name: 'Enter pairing code' })
    ).toBeTruthy()
    expect(
      screen.getByRole('tab', { name: 'Sniffer', hidden: true })
    ).toBeTruthy()

    await user.type(input, 'MTX7K2Q9')
    await user.click(screen.getByRole('button', { name: /pair/i }))

    await waitFor(() => {
      const submissions = sendMessage.mock.calls
        .map(([raw]) => raw as Envelope)
        .filter(({ kind }) => kind === 'bg.submitPairingCode')
      expect(submissions).toEqual([
        { kind: 'bg.submitPairingCode', payload: { code: 'MTX7K2Q9' } },
      ])
    })
  })

  it('lets a pending pairing prompt yield to offline resource discovery and reopen later', async () => {
    const deadlineMs = Date.now() + 60_000
    const sendMessage = vi.fn(async (msg: unknown) => {
      const env = msg as Envelope
      if (env.kind === 'bg.getState') {
        return {
          ...SNAPSHOT,
          state: 'awaiting-code',
          pairingCode: {
            instanceId: 'motrix-desktop-1',
            run: 1,
            maxRuns: 3,
            attemptsRemaining: null,
            deadlineMs,
          },
        }
      }
      if (env.kind === 'bg.hasPairedBackend') return { paired: true }
      if (env.kind === 'bg.getEndpointConfig') {
        return LOCAL_ENDPOINT
      }
      if (env.kind === 'bg.scanActiveTab') {
        return { media: [MEDIA_ITEM], selectionKinds: ['direct'] }
      }
      if (env.kind === 'bg.getTakeoverConfig') {
        return {
          enabled: true,
          consentAckVersion: 1,
          defaultAction: 'motrix',
          rules: [],
        }
      }
      if (env.kind === 'bg.getNotificationsConfig') {
        return { master: true, confirm: false, error: true, reminder: true }
      }
      return { ok: true }
    })
    browser.runtime.sendMessage = sendMessage
    const user = userEvent.setup()

    render(<App />)

    const dialog = await screen.findByRole('dialog', {
      name: i18n.t('popup.pairing.dialogTitle'),
    })
    await user.click(
      within(dialog).getByRole('button', {
        name: i18n.t('popup.pairing.dismissPrompt'),
      })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: i18n.t('popup.pairing.dialogTitle'),
        })
      ).toBeNull()
    )

    await user.click(screen.getByRole('tab', { name: 'Sniffer' }))
    const selection = await screen.findByRole('checkbox', {
      name: 'Select video.mp4',
    })
    expect((selection as HTMLInputElement).disabled).toBe(false)
    await user.click(selection)
    expect((selection as HTMLInputElement).checked).toBe(true)

    await user.click(screen.getByRole('tab', { name: 'Tasks' }))
    await user.click(
      screen.getByRole('button', {
        name: i18n.t('popup.pairing.enterCode'),
      })
    )
    const reopenedDialog = await screen.findByRole('dialog', {
      name: i18n.t('popup.pairing.dialogTitle'),
    })
    await user.click(
      within(reopenedDialog).getByRole('button', {
        name: i18n.t('popup.pairing.dismissPrompt'),
      })
    )
    await user.click(screen.getByRole('tab', { name: 'Sniffer' }))
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Select video.mp4',
        }) as HTMLInputElement
      ).checked
    ).toBe(true)
  })

  it('opens the options page from the settings button', async () => {
    installConnectedBus()

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))

    expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce()
  })

  it('shows App and every configured Server as the only radio choices', async () => {
    installConnectedBus()
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText('Motrix App')
    const trigger = screen.getByRole('button', {
      name: /^Choose Motrix backend:/,
    })
    await user.click(trigger)

    expect(
      await screen.findByRole('menuitemradio', { name: /Motrix App/ })
    ).toBeTruthy()
    expect(
      screen.getByRole('menuitemradio', { name: /Studio Server/ })
    ).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /Home NAS/ })).toBeTruthy()
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
    expect(screen.queryByText(/Motrix · electron/i)).toBeNull()
    expect(screen.getByRole('menuitem', { name: /Motrix Server/ })).toBeTruthy()
  })

  it('offers only Motrix Server setup when Native Messaging is unavailable', async () => {
    const connectNative = browser.runtime.connectNative
    browser.runtime.connectNative = undefined
    browser.runtime.sendMessage = vi.fn(async (msg: unknown) => {
      const env = msg as Envelope
      if (env.kind === 'bg.getState')
        return { ...SNAPSHOT, state: 'disconnected' }
      if (env.kind === 'bg.hasPairedBackend') return { paired: true }
      if (env.kind === 'bg.getEndpointConfig') return LOCAL_ENDPOINT
      if (env.kind === 'bg.scanActiveTab') {
        return { media: [], selectionKinds: ['direct'] }
      }
      return { ok: true }
    })

    try {
      const user = userEvent.setup()
      render(<App />)

      const trigger = await screen.findByRole('button', {
        name: /^Choose Motrix backend: Motrix Server/,
      })
      await user.click(trigger)
      expect(
        screen.queryByRole('menuitemradio', { name: /Motrix App/ })
      ).toBeNull()
      expect(
        await screen.findByRole('menuitemradio', { name: /Studio Server/ })
      ).toBeTruthy()
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(2)

      await user.click(
        screen.getByRole('menuitem', { name: /Manage Motrix Servers/ })
      )
      expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce()
    } finally {
      browser.runtime.connectNative = connectNative
    }
  })

  it('switches between configured servers and marks only the active radio item', async () => {
    const sendMessage = installConnectedBus()
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText('Motrix App')
    const trigger = screen.getByRole('button', {
      name: /^Choose Motrix backend:/,
    })
    await user.click(trigger)
    const localChoice = await screen.findByRole('menuitemradio', {
      name: /Motrix App/,
    })
    expect(localChoice.getAttribute('aria-checked')).toBe('true')
    await user.click(
      screen.getByRole('menuitemradio', { name: /Studio Server/ })
    )

    await waitFor(() => {
      expect(within(trigger).getByText('Studio Server')).toBeTruthy()
    })
    const configured = sendMessage.mock.calls
      .map(([raw]) => raw as Envelope)
      .filter(({ kind }) => kind === 'bg.activateEndpoint')
    expect(configured[0]?.payload).toEqual({ endpointId: 'studio' })

    expect(
      screen
        .getByRole('menuitemradio', { name: /Studio Server/ })
        .getAttribute('aria-checked')
    ).toBe('true')
    expect(
      screen
        .getByRole('menuitemradio', { name: /Home NAS/ })
        .getAttribute('aria-checked')
    ).toBe('false')

    await user.click(screen.getByRole('menuitemradio', { name: /Home NAS/ }))
    await waitFor(() => {
      expect(within(trigger).getByText('Home NAS')).toBeTruthy()
    })
    const switches = sendMessage.mock.calls
      .map(([raw]) => raw as Envelope)
      .filter(({ kind }) => kind === 'bg.activateEndpoint')
    expect(switches[1]?.payload).toEqual({ endpointId: 'nas' })
  })

  it('starts resource discovery before the Sniffer tab is selected', async () => {
    const sendMessage = installConnectedBus()
    render(<App />)

    await screen.findByText('ubuntu.iso')
    await waitFor(() => {
      expect(
        sendMessage.mock.calls.some(
          ([msg]) => (msg as Envelope).kind === 'bg.scanActiveTab'
        )
      ).toBe(true)
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Sniffer' }))
    expect(
      await screen.findByRole('heading', { name: 'Page resources' })
    ).toBeTruthy()
  })

  it('creates a manual task from the compact toolbar and refreshes the active list', async () => {
    const sendMessage = installConnectedBus()
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText('ubuntu.iso')

    const listCallsBefore = sendMessage.mock.calls.filter(
      ([raw]) => (raw as Envelope).kind === 'bg.taskList'
    ).length
    await user.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Download address' }),
      'https://example.com/new-file.zip'
    )
    await user.click(within(dialog).getByRole('button', { name: 'Add' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull()
    )
    const createCall = sendMessage.mock.calls
      .map(([raw]) => raw as Envelope)
      .find(({ kind }) => kind === 'bg.createManualTask')
    expect(createCall).toEqual({
      kind: 'bg.createManualTask',
      payload: {
        input: 'https://example.com/new-file.zip',
        options: defaultTaskOptions(navigator.userAgent),
        idempotencyKey: expect.any(String),
      },
    })
    await waitFor(() => {
      expect(
        sendMessage.mock.calls.filter(
          ([raw]) => (raw as Envelope).kind === 'bg.taskList'
        ).length
      ).toBeGreaterThan(listCallsBefore)
    })
  })

  it('keeps page resources discoverable and selectable while Motrix is offline', async () => {
    const sendMessage = vi.fn(async (msg: unknown) => {
      const env = msg as Envelope
      if (env.kind === 'bg.getState') {
        return {
          ...SNAPSHOT,
          state: 'disconnected',
          lastError: 'socket ECONNREFUSED',
          attemptIntent: 'background-probe',
        }
      }
      if (env.kind === 'bg.hasPairedBackend') return { paired: true }
      if (env.kind === 'bg.getEndpointConfig') {
        return LOCAL_ENDPOINT
      }
      if (env.kind === 'bg.scanActiveTab') {
        return { media: [MEDIA_ITEM], selectionKinds: ['direct'] }
      }
      if (env.kind === 'bg.getTakeoverConfig') {
        return {
          enabled: true,
          consentAckVersion: 1,
          defaultAction: 'motrix',
          rules: [],
        }
      }
      if (env.kind === 'bg.getNotificationsConfig') {
        return { master: true, confirm: false, error: true, reminder: true }
      }
      return { ok: true }
    })
    browser.runtime.sendMessage = sendMessage
    const user = userEvent.setup()

    render(<App />)
    await user.click(screen.getByRole('tab', { name: 'Sniffer' }))

    const selection = await screen.findByRole('checkbox', {
      name: 'Select video.mp4',
    })
    expect((selection as HTMLInputElement).disabled).toBe(false)
    await user.click(selection)
    expect((selection as HTMLInputElement).checked).toBe(true)

    const row = screen.getByTestId(`resource-row-${MEDIA_ITEM.url}`)
    const submit = within(row).getByRole('button')
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText('socket ECONNREFUSED')).toBeNull()

    const resourceTile = screen.getByTestId('tile-resources')
    expect(within(resourceTile).getByText('1')).toBeTruthy()

    await user.click(screen.getByRole('tab', { name: 'Tasks' }))
    await user.click(screen.getByRole('tab', { name: 'Sniffer' }))
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Select video.mp4',
        }) as HTMLInputElement
      ).checked
    ).toBe(true)
    expect(
      sendMessage.mock.calls.filter(
        ([raw]) => (raw as Envelope).kind === 'bg.scanActiveTab'
      )
    ).toHaveLength(1)
  })

  it('allows the same resource to be sent again after switching backends', async () => {
    let activeEndpointId = 'local'
    const sendMessage = vi.fn(async (msg: unknown) => {
      const env = msg as Envelope
      if (env.kind === 'bg.getState') {
        return {
          ...SNAPSHOT,
          state: 'connected',
          endpoint: { ...LOCAL_ENDPOINT, activeEndpointId },
          server: {
            name: activeEndpointId === 'local' ? 'Motrix' : 'Studio Server',
            version: '2.0.0',
            runtime: activeEndpointId === 'local' ? 'electron' : 'server',
          },
        }
      }
      if (env.kind === 'bg.hasPairedBackend') return { paired: true }
      if (env.kind === 'bg.getEndpointConfig') {
        return {
          ...LOCAL_ENDPOINT,
          activeEndpointId,
        }
      }
      if (env.kind === 'bg.activateEndpoint') {
        activeEndpointId = (env.payload as { endpointId: string }).endpointId
        return {
          config: {
            ...LOCAL_ENDPOINT,
            activeEndpointId,
          },
        }
      }
      if (env.kind === 'bg.taskList') return { tasks: [], total: 0 }
      if (env.kind === 'bg.statsGet') {
        return {
          totalDownloadSpeed: 0,
          totalUploadSpeed: 0,
          activeTasks: 0,
          waitingTasks: 0,
          stoppedTasks: 0,
        }
      }
      if (env.kind === 'bg.engineStatus') {
        return { state: 'ready', featureReport: null }
      }
      if (env.kind === 'bg.scanActiveTab') {
        return { media: [MEDIA_ITEM], selectionKinds: ['direct', 'mux'] }
      }
      if (env.kind === 'bg.submitMedia') return { taskId: 'task-media' }
      if (env.kind === 'bg.getTakeoverConfig') {
        return {
          enabled: true,
          consentAckVersion: 1,
          defaultAction: 'motrix',
          rules: [],
        }
      }
      if (env.kind === 'bg.getNotificationsConfig') {
        return { master: true, confirm: false, error: true, reminder: true }
      }
      return { ok: true }
    })
    browser.runtime.sendMessage = sendMessage
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText('Motrix App')
    await user.click(screen.getByRole('tab', { name: 'Sniffer' }))

    let resource = await screen.findByRole('button', {
      name: 'Quick download video.mp4',
    })
    await user.click(resource)
    await screen.findByRole('button', { name: 'Sent video.mp4' })

    await user.click(
      screen.getByRole('button', { name: /^Choose Motrix backend:/ })
    )
    await user.click(
      await screen.findByRole('menuitemradio', { name: /Studio Server/ })
    )

    await waitFor(
      () => {
        resource = screen.getByRole('button', {
          name: 'Quick download video.mp4',
        })
        expect((resource as HTMLButtonElement).disabled).toBe(false)
      },
      { timeout: 2500 }
    )
    await user.click(resource)

    await waitFor(() => {
      const submissions = sendMessage.mock.calls.filter(
        ([raw]) => (raw as Envelope).kind === 'bg.submitMedia'
      )
      expect(submissions).toHaveLength(2)
      const firstRaw = submissions.at(0)?.at(0)
      const secondRaw = submissions.at(1)?.at(0)
      if (!firstRaw || !secondRaw) throw new Error('missing submission')
      const first = (firstRaw as Envelope<'bg.submitMedia'>).payload
      const second = (secondRaw as Envelope<'bg.submitMedia'>).payload
      expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
    })
  })
})

it.each(['header', 'quick settings'])(
  'blocks the %s takeover switch before pairing',
  async (entry) => {
    const baseSend = installConnectedBus()
    browser.runtime.sendMessage = vi.fn(async (message: unknown) => {
      const env = message as Envelope
      if (env.kind === 'bg.hasPairedBackend') return { paired: false }
      if (env.kind === 'bg.getTakeoverConfig')
        return {
          enabled: false,
          consentAckVersion: 1,
          defaultAction: 'motrix',
          rules: [],
          openTaskPanelAfterSubmit: false,
        }
      return baseSend(message)
    })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('ubuntu.iso')
    if (entry === 'quick settings')
      await user.click(
        screen.getByRole('tab', { name: i18n.t('popup.tabs.settings') })
      )
    const toggle =
      entry === 'header'
        ? screen.getByTestId('takeover-switch')
        : screen.getByRole('switch', {
            name: i18n.t('options.takeover.enableLabel'),
          })
    await user.click(toggle)
    const dialog = await screen.findByRole('alertdialog', {
      name: i18n.t('options.takeover.pairingRequiredTitle'),
    })
    expect(within(dialog).getAllByRole('button')).toHaveLength(3)
    expect(
      within(dialog).getByRole('button', {
        name: i18n.t('options.takeover.pairApp'),
      })
    ).toBeTruthy()
    expect(
      within(dialog).getByRole('button', {
        name: i18n.t('options.takeover.addServerPair'),
      })
    ).toBeTruthy()
    await user.click(
      within(dialog).getByRole('button', {
        name: i18n.t('options.common.cancel'),
      })
    )
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(
      vi
        .mocked(browser.runtime.sendMessage)
        .mock.calls.some(
          ([message]) =>
            (message as Envelope).kind === 'bg.patchTakeoverEnabled'
        )
    ).toBe(false)
  }
)
