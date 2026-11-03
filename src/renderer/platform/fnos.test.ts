import { useOperatorSession } from '@renderer/lib/operator-auth'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fnosFileAction, pickFnosDirectory } from './fnos'

const sdk = vi.hoisted(() => ({
  ready: vi.fn().mockResolvedValue(undefined),
  isStandaloneWeb: false,
  pickSharedFile: vi.fn(),
  buildAppAuthUrl: vi.fn(),
  openFile: vi.fn(),
  openFileManager: vi.fn(),
}))
vi.mock('@trimjs/web-app', () => ({
  TrimApp: class {
    ready = sdk.ready
    pickSharedFile = sdk.pickSharedFile
    buildAppAuthUrl = sdk.buildAppAuthUrl
    openFile = sdk.openFile
    openFileManager = sdk.openFileManager
    get isStandaloneWeb() {
      return sdk.isStandaloneWeb
    }
  },
}))
const fetchMock = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  sdk.isStandaloneWeb = false
  vi.stubGlobal('fetch', fetchMock)
  useOperatorSession.setState({
    state: 'authenticated',
    status: { authed: true, mode: 'fnosGateway', canLogout: false },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('validates the host-selected directory with the backend before accepting it', async () => {
  sdk.pickSharedFile.mockResolvedValue({ code: 0, data: ['/volume/alias'] })
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ path: '/volume/canonical' }))
  )
  expect(await pickFnosDirectory()).toBe('/volume/canonical')
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/api/fnos/directory'),
    expect.objectContaining({ body: JSON.stringify({ path: '/volume/alias' }) })
  )
  fetchMock.mockResolvedValue(new Response('', { status: 403 }))
  await expect(pickFnosDirectory()).rejects.toThrow('403')
})
it('uses a server-resolved task path for the file manager', async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ path: '/volume/output' }))
  )
  await fnosFileAction('task-123', 'reveal')
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
    taskId: 'task-123',
    action: 'reveal',
  })
  expect(sdk.openFileManager).toHaveBeenCalledWith('/volume/output')
})
it('accepts standalone callbacks only from the exact popup, origin and request state', async () => {
  const random = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
  // Model an ordinary HTTP NAS origin, which has no randomUUID method.
  vi.stubGlobal('crypto', { getRandomValues: random })
  sdk.isStandaloneWeb = true
  sdk.buildAppAuthUrl.mockResolvedValue('https://nas.local/auth')
  const popup = { location: { href: '' }, close: vi.fn() }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ path: '/volume/allowed' }))
  )
  const pending = pickFnosDirectory()
  await vi.waitFor(() => expect(sdk.buildAppAuthUrl).toHaveBeenCalledOnce())
  const state = sdk.buildAppAuthUrl.mock.calls[0][1].state
  expect(state).toMatch(/^[a-f0-9]{32}$/)
  const send = (origin: string, returnedState: string, source: object) => {
    const event = new MessageEvent('message', {
      origin,
      data: {
        type: 'motrix:fnos-auth',
        result: {
          method: 'pickSharedFile',
          appName: 'motrix',
          status: 'success',
          state: returnedState,
          path: ['/volume/allowed'],
        },
      },
    })
    Object.defineProperty(event, 'source', { value: source })
    window.dispatchEvent(event)
  }
  send('https://evil.example', state, popup)
  send(location.origin, 'wrong', popup)
  send(location.origin, state, {})
  expect(fetchMock).not.toHaveBeenCalled()
  send(location.origin, state, popup)
  expect(await pending).toBe('/volume/allowed')
})
