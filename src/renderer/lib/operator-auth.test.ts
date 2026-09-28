import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  operatorLogin,
  operatorLogout,
  refreshOperatorSession,
  useOperatorSession,
} from './operator-auth'

const fetchMock = vi.fn()
const authed = () =>
  new Response(
    JSON.stringify({ authed: true, mode: 'cookie', canLogout: true })
  )
const locked = () =>
  new Response(
    JSON.stringify({ authed: false, mode: 'unauthenticated', canLogout: false })
  )
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useOperatorSession.setState({
    state: 'authenticated',
    status: { authed: true, mode: 'cookie', canLogout: true },
    epoch: useOperatorSession.getState().epoch + 1,
  })
})
afterEach(() => vi.unstubAllGlobals())
it('preserves authentication on network failure and forbidden responses', async () => {
  fetchMock
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(new Response('', { status: 403 }))
  await refreshOperatorSession()
  await refreshOperatorSession()
  expect(useOperatorSession.getState().state).toBe('authenticated')
})
it('ignores an old status response after a successful new login', async () => {
  let resolve!: (response: Response) => void
  fetchMock
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        })
    )
    .mockResolvedValueOnce(new Response('{}'))
    .mockResolvedValueOnce(authed())
  const old = refreshOperatorSession()
  expect(await operatorLogin('token')).toBe(true)
  resolve(locked())
  await old
  expect(useOperatorSession.getState().state).toBe('authenticated')
})
it('checks the server instead of trusting a stale cross-tab hint', async () => {
  fetchMock.mockResolvedValueOnce(authed())
  await refreshOperatorSession()
  expect(useOperatorSession.getState().state).toBe('authenticated')
})
it('does not retry logout or fake successful logout after a network failure', async () => {
  fetchMock
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(authed())
  await expect(operatorLogout()).rejects.toThrow('offline')
  expect(
    fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')
  ).toHaveLength(1)
  expect(useOperatorSession.getState().state).toBe('authenticated')
})
it('blocks mutations during logout and locks only after confirmation', async () => {
  let resolve!: (response: Response) => void
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done
      })
  )
  const logout = operatorLogout()
  expect(useOperatorSession.getState().state).toBe('logging-out')
  resolve(new Response('{}'))
  await logout
  expect(useOperatorSession.getState().state).toBe('locked')
})
