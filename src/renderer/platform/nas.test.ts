import '@renderer/lib/i18n'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { synologyFileAction } from './nas'

const fetchMock = vi.fn()
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  useOperatorSession.setState({
    state: 'authenticated',
    status: {
      authed: true,
      mode: 'synologyDsm',
      canLogout: false,
      nasCapabilities: {
        settings: true,
        fileActions: true,
        torrentPicker: true,
        clientGateway: true,
      },
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('opens File Station only after the task-scoped backend check and clears the opener', async () => {
  const popup = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  const url =
    '/?launchApp=SYNO.SDS.App.FileStation3.Instance&launchParam=openfile%3D%252Fmotrix%252F'
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ kind: 'file-manager', url }))
  )
  await synologyFileAction('task-123', 'reveal')
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
    taskId: 'task-123',
    action: 'reveal',
  })
  expect(popup.opener).toBeNull()
  expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(
    `${location.origin}${url}`
  )
})

it.each(['/motrix/api/nas/tasks/other-task/file', '//outside.test/file'])(
  'rejects a substituted download target: %s',
  async (url) => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ kind: 'download', url }))
    )
    await expect(synologyFileAction('task-123', 'open')).rejects.toThrow()
    expect(click).not.toHaveBeenCalled()
  }
)

it('closes the preopened window when permissions have changed', async () => {
  const popup = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  fetchMock.mockResolvedValue(new Response('', { status: 403 }))
  await expect(synologyFileAction('task-123', 'reveal')).rejects.toThrow()
  expect(popup.close).toHaveBeenCalledOnce()
  expect(popup.location.replace).not.toHaveBeenCalled()
})
