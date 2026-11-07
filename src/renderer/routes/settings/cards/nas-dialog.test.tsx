import '@test-utils/dom-animations'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { NasStorageRecovery } from '@renderer/components/nas-storage-recovery'
import { i18n } from '@renderer/lib/i18n'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { NasSettingsView } from '@shared/schemas/nas-settings'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { NasDialog } from './nas-dialog'

vi.mock('@renderer/lib/transport', () => ({
  transport: { platform: 'web', invoke: vi.fn(), onConnectionChange: vi.fn() },
}))
const settings = {
  roots: ['/volume1/motrix'],
  clientPort: 16802,
  extensionUrl: '',
  operatorUrl: 'https://nas.test:5001/motrix/',
  allowHttp: false,
}
let view: NasSettingsView,
  reconnect: ((event: { state: 'connected' }) => void) | undefined
beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  vi.clearAllMocks()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  useOperatorSession.setState({
    state: 'authenticated',
    status: {
      authed: true,
      mode: 'synologyDsm',
      canLogout: false,
      username: 'alice',
    },
  })
  view = {
    platform: 'synology',
    revision: 'a'.repeat(64),
    settings,
    active: settings,
    restartRequired: false,
  }
  const subscribe = transport.onConnectionChange
  if (!subscribe) throw new Error('Missing test transport subscription')
  vi.mocked(subscribe).mockImplementation((callback) => {
    reconnect = callback
    return () => {}
  })
  vi.mocked(transport.invoke).mockImplementation(async (channel, request) => {
    if (channel === Queries.GetNasSettings) return { ok: true, value: view }
    if (channel === Commands.SaveNasSettings) {
      const next = request as { settings: typeof settings }
      return {
        ok: true,
        value: {
          ...view,
          revision: 'b'.repeat(64),
          settings: next.settings,
          restartRequired: true,
        },
      }
    }
    throw new Error('Unexpected test request')
  })
})
function open() {
  render(
    <NasDialog
      open
      onClose={vi.fn()}
      labelKey="settings.cards.nas.title"
      descKey="settings.cards.nas.desc"
    />
  )
}
it('repairs an unavailable folder without changing saved client addresses or ports', async () => {
  const missing = '/volume2/missing'
  const applied = { ...settings, roots: [missing], operatorUrl: '' }
  view = { ...view, settings: applied, active: applied }
  useOperatorSession.setState({
    status: {
      ...useOperatorSession.getState().status!,
      nasUnavailableDownloadRoots: [missing],
    },
  })
  render(<NasStorageRecovery roots={[missing]} />)
  expect(screen.getByText(missing)).toBeVisible()
  fireEvent.click(
    screen.getByRole('button', { name: 'Authorized download folders' })
  )
  const folders = await screen.findByRole('textbox', {
    name: 'Authorized download folders',
  })
  await waitFor(() => expect(folders).toBeEnabled())
  expect(screen.queryByRole('spinbutton')).toBeNull()
  expect(screen.queryByText('CLI endpoint')).toBeNull()
  fireEvent.change(folders, { target: { value: '/volume1/motrix' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText(i18n.t('settings.nas.restartRequired'))
  expect(transport.invoke).toHaveBeenCalledWith(Commands.SaveNasSettings, {
    revision: view.revision,
    settings: { ...applied, roots: ['/volume1/motrix'] },
  })
})

it('saves explicit package settings with a revision and shows the restart requirement', async () => {
  open()
  const port = await screen.findByRole('spinbutton', {
    name: 'Direct client port',
  })
  await waitFor(() => expect(port).toBeEnabled())
  fireEvent.change(port, { target: { value: '16812' } })
  fireEvent.click(
    screen.getByRole('switch', { name: 'Enable browser extension connections' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText(i18n.t('settings.nas.restartRequired'))
  expect(transport.invoke).toHaveBeenCalledWith(Commands.SaveNasSettings, {
    revision: 'a'.repeat(64),
    settings: {
      ...settings,
      clientPort: 16812,
      extensionUrl: 'wss://nas.test:5001/motrix/bridge',
    },
  })
  expect(screen.getByRole('textbox', { name: 'CLI endpoint' })).toHaveValue(
    'https://nas.test:5001/motrix/client'
  )
})
it('preserves an unsaved draft across reconnects and rejects a changed baseline', async () => {
  open()
  const port = await screen.findByRole('spinbutton', {
    name: 'Direct client port',
  })
  await waitFor(() => expect(port).toBeEnabled())
  fireEvent.change(port, { target: { value: '16812' } })
  await act(async () => {
    reconnect?.({ state: 'connected' })
  })
  expect(port).toHaveValue(16812)
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  view = {
    ...view,
    revision: 'b'.repeat(64),
    settings: { ...settings, clientPort: 16815 },
  }
  await act(async () => {
    reconnect?.({ state: 'connected' })
  })
  await screen.findByText(/The saved configuration changed/)
  expect(port).toHaveValue(16812)
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(port).toHaveValue(16815))
})
it('never enables saving before an authoritative baseline is available', async () => {
  vi.mocked(transport.invoke).mockResolvedValue({
    ok: false,
    error: { code: 'permissionDenied' },
  })
  open()
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
})
