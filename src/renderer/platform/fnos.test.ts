import { useOperatorSession } from '@renderer/lib/operator-auth'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  fnosFileAction,
  fnosPlatformConfig,
  fnosSdk,
  parseFnosAuthCallback,
  pickFnosDirectory,
  watchFnosPlatform,
} from './fnos'

const sdk = vi.hoisted(() => ({
  ready: vi.fn(),
  reconnectHost: vi.fn(),
  isWeb: false,
  isStandaloneWeb: false,
  pickSharedFile: vi.fn(),
  buildAppAuthUrl: vi.fn(),
  parseAppAuthCallback: vi.fn(),
  openFile: vi.fn(),
  openFileManager: vi.fn(),
  getPlatformConfig: vi.fn(),
  listeners: new Map<string, (value: unknown) => void>(),
}))
vi.mock('@trimjs/web-app', () => ({
  TrimApp: class {
    ready = sdk.ready
    reconnectHost = sdk.reconnectHost
    pickSharedFile = sdk.pickSharedFile
    buildAppAuthUrl = sdk.buildAppAuthUrl
    parseAppAuthCallback = sdk.parseAppAuthCallback
    openFile = sdk.openFile
    openFileManager = sdk.openFileManager
    getPlatformConfig = sdk.getPlatformConfig
    get isWeb() {
      return sdk.isWeb
    }
    get isStandaloneWeb() {
      return sdk.isStandaloneWeb
    }
    async $on(event: string, handler: (value: unknown) => void) {
      sdk.listeners.set(event, handler)
    }
    async $off(event: string, handler: (value: unknown) => void) {
      if (sdk.listeners.get(event) === handler) sdk.listeners.delete(event)
    }
  },
}))

const fetchMock = vi.fn()
let popup: {
  location: { href: string }
  closed: boolean
  close: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
  sdk.ready.mockReset().mockResolvedValue(undefined)
  sdk.reconnectHost.mockReset().mockResolvedValue(undefined)
  sdk.isWeb = false
  sdk.isStandaloneWeb = false
  sdk.listeners.clear()
  sdk.getPlatformConfig.mockResolvedValue({
    theme: 'light',
    language: 'en-US',
    systemVersion: '1.2.0401',
    format: {},
  })
  sdk.openFile.mockReset().mockResolvedValue(undefined)
  sdk.openFileManager.mockReset().mockResolvedValue(undefined)
  sdk.buildAppAuthUrl
    .mockReset()
    .mockResolvedValue(`${location.origin}/app-auth/pick-shared-file`)
  fetchMock
    .mockReset()
    .mockResolvedValue(
      new Response(JSON.stringify({ path: '/volume/allowed' }))
    )
  vi.stubGlobal('fetch', fetchMock)
  popup = { location: { href: '' }, closed: false, close: vi.fn() }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  useOperatorSession.setState({
    state: 'authenticated',
    status: { authed: true, mode: 'fnosGateway', canLogout: false },
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function sendCallback(
  status: 'success' | 'cancel' | 'error',
  overrides: {
    origin?: string
    source?: object
    state?: string
    method?: string
    appName?: string
  } = {}
) {
  const state = sdk.buildAppAuthUrl.mock.calls[0][1].state
  const event = new MessageEvent('message', {
    origin: overrides.origin ?? location.origin,
    data: {
      type: 'motrix:fnos-auth',
      result: {
        method: 'pickSharedFile',
        appName: 'motrix',
        state,
        status,
        path: ['/volume/allowed'],
        ...overrides,
      },
    },
  })
  Object.defineProperty(event, 'source', { value: overrides.source ?? popup })
  window.dispatchEvent(event)
}

it('validates the native host-selected directory with the backend', async () => {
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

it('reports a native authorization rejection and treats cancellation separately', async () => {
  sdk.pickSharedFile.mockResolvedValue({ code: 1, data: [] })
  await expect(pickFnosDirectory()).rejects.toThrow('could not be authorized')
  expect(fetchMock).not.toHaveBeenCalled()
  sdk.pickSharedFile.mockResolvedValue(undefined)
  expect(await pickFnosDirectory()).toBeNull()
})

it('uses a server-authorized task path for file actions and surfaces unsupported hosts', async () => {
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ path: '/volume/output' })))
  )
  await fnosFileAction('task-123', 'reveal')
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
    taskId: 'task-123',
    action: 'reveal',
  })
  expect(sdk.openFileManager).toHaveBeenCalledWith('/volume/output')
  sdk.openFile.mockRejectedValue(
    Object.assign(new Error('unsupported'), {
      code: 'NotSupportedInExtensionHost',
    })
  )
  await expect(fnosFileAction('task-123', 'open')).rejects.toThrow(
    'fnOS desktop or mobile app'
  )
  sdk.openFileManager.mockResolvedValue({ code: 1000002 })
  await expect(fnosFileAction('task-123', 'reveal')).rejects.toThrow(
    'could not be authorized'
  )
})

it.each([true, false])(
  'rejects file actions in top-level Web pages before calling SDK stubs (standalone=%s)',
  async (standalone) => {
    sdk.isWeb = true
    sdk.isStandaloneWeb = standalone
    await expect(fnosFileAction('task-123', 'open')).rejects.toThrow(
      'fnOS desktop or mobile app'
    )
    await expect(fnosFileAction('task-123', 'reveal')).rejects.toThrow(
      'fnOS desktop or mobile app'
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sdk.openFile).not.toHaveBeenCalled()
    expect(sdk.openFileManager).not.toHaveBeenCalled()
  }
)

it.each([true, false])(
  'uses App Auth for a top-level Web page (standalone=%s)',
  async (standalone) => {
    sdk.isWeb = true
    sdk.isStandaloneWeb = standalone
    const pending = pickFnosDirectory()
    await vi.waitFor(() => expect(sdk.buildAppAuthUrl).toHaveBeenCalledOnce())
    expect(sdk.pickSharedFile).not.toHaveBeenCalled()
    sendCallback('success')
    expect(await pending).toBe('/volume/allowed')
    expect(popup.close).toHaveBeenCalled()
  }
)

it('reserves the popup during the click before awaiting host discovery', async () => {
  sdk.isWeb = true
  sdk.isStandaloneWeb = true
  let finishReady: (() => void) | undefined
  sdk.ready.mockReturnValue(
    new Promise<void>((resolve) => {
      finishReady = resolve
    })
  )
  const pending = pickFnosDirectory()
  expect(window.open).toHaveBeenCalledOnce()
  expect(sdk.buildAppAuthUrl).not.toHaveBeenCalled()
  finishReady?.()
  await vi.waitFor(() => expect(sdk.buildAppAuthUrl).toHaveBeenCalledOnce())
  sendCallback('cancel')
  expect(await pending).toBeNull()
})

it('accepts only the exact popup, origin, application, method and request state on LAN HTTP', async () => {
  const random = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
  vi.stubGlobal('crypto', { getRandomValues: random })
  sdk.isWeb = true
  sdk.isStandaloneWeb = true
  const pending = pickFnosDirectory()
  await vi.waitFor(() => expect(sdk.buildAppAuthUrl).toHaveBeenCalledOnce())
  expect(sdk.buildAppAuthUrl.mock.calls[0][1].state).toMatch(/^[a-f0-9]{32}$/)
  for (const invalid of [
    { origin: 'https://evil.example' },
    { state: 'wrong' },
    { source: {} },
    { method: 'pickUserFile' },
    { appName: 'another-app' },
  ])
    sendCallback('success', invalid)
  expect(fetchMock).not.toHaveBeenCalled()
  sendCallback('success')
  expect(await pending).toBe('/volume/allowed')
  expect(popup.close).toHaveBeenCalledOnce()
})

it('reports authorization errors without treating denial as cancellation', async () => {
  sdk.isWeb = true
  sdk.isStandaloneWeb = true
  const pending = pickFnosDirectory()
  const rejected = expect(pending).rejects.toThrow('could not be authorized')
  await vi.waitFor(() => expect(sdk.buildAppAuthUrl).toHaveBeenCalledOnce())
  sendCallback('error')
  await rejected
  expect(fetchMock).not.toHaveBeenCalled()
})

it('reports blocked popups and refuses cross-origin authorization navigation', async () => {
  sdk.isWeb = true
  sdk.isStandaloneWeb = true
  vi.mocked(window.open).mockReturnValueOnce(null)
  await expect(pickFnosDirectory()).rejects.toThrow('Allow popups')
  sdk.buildAppAuthUrl.mockResolvedValueOnce('https://evil.example/authorize')
  await expect(pickFnosDirectory()).rejects.toThrow('gateway origin')
  expect(popup.location.href).toBe('')
  expect(popup.close).toHaveBeenCalled()
})

it('settles a manually closed authorization window and removes its listener', async () => {
  vi.useFakeTimers()
  sdk.isWeb = true
  sdk.isStandaloneWeb = true
  const pending = pickFnosDirectory()
  await vi.advanceTimersByTimeAsync(0)
  popup.closed = true
  await vi.advanceTimersByTimeAsync(500)
  expect(await pending).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  sendCallback('success')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('reconnects after initialization failure and allows later callers to recover', async () => {
  sdk.ready
    .mockRejectedValueOnce(new Error('host not ready'))
    .mockResolvedValue(undefined)
  await fnosSdk()
  expect(sdk.reconnectHost).toHaveBeenCalledOnce()
  sdk.ready.mockRejectedValueOnce(new Error('host disconnected'))
  sdk.reconnectHost.mockRejectedValueOnce(new Error('still offline'))
  await expect(fnosSdk()).rejects.toThrow('still offline')
  sdk.ready.mockResolvedValue(undefined)
  await fnosSdk()
})

it('parses authorization callbacks while host discovery is still pending', async () => {
  sdk.ready.mockReturnValue(new Promise(() => {}))
  sdk.parseAppAuthCallback.mockReturnValue({ status: 'cancel', state: 'state' })
  expect(
    await parseFnosAuthCallback('http://nas.local/app/motrix/?callback')
  ).toEqual({ status: 'cancel', state: 'state' })
  expect(sdk.reconnectHost).not.toHaveBeenCalled()
})

it('uses validated theme and language events over a cached SDK snapshot and unsubscribes', async () => {
  sdk.isWeb = true
  const refresh = vi.fn()
  const stopTheme = watchFnosPlatform('os/theme', refresh)
  const stopLanguage = watchFnosPlatform('os/language', refresh)
  await vi.waitFor(() => expect(sdk.listeners.size).toBe(2))
  const theme = sdk.listeners.get('os/theme')
  const language = sdk.listeners.get('os/language')
  if (!theme || !language) throw new Error('Missing platform listeners')
  theme({ theme: 'dark' })
  language('zh-TW')
  expect(await fnosPlatformConfig()).toMatchObject({
    theme: 'dark',
    language: 'zh-TW',
  })
  theme('invalid')
  theme({ theme: 'invalid' })
  theme(null)
  language({ language: 'de' })
  expect(refresh).toHaveBeenCalledTimes(2)
  theme('light')
  expect(refresh).toHaveBeenLastCalledWith('light')
  stopTheme()
  stopLanguage()
  theme('light')
  expect(refresh).toHaveBeenCalledTimes(3)
  await vi.waitFor(() => expect(sdk.listeners.size).toBe(0))
})
