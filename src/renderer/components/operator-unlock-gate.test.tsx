import '@renderer/lib/i18n'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperatorUnlockGate } from './operator-unlock-gate'

const { transportMock } = vi.hoisted(() => ({
  transportMock: { platform: 'web' as string },
}))
vi.mock('@renderer/lib/transport', () => ({ transport: transportMock }))
const fetchMock = vi.fn()
const reply = (authed: boolean) =>
  new Response(
    JSON.stringify({
      authed,
      mode: authed ? 'cookie' : 'unauthenticated',
      canLogout: authed,
    })
  )
const child = <div data-testid="app">APP</div>
beforeEach(() => {
  transportMock.platform = 'web'
  useOperatorSession.setState({
    state: 'checking',
    status: null,
    epoch: useOperatorSession.getState().epoch + 1,
  })
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())
describe('OperatorUnlockGate', () => {
  it('bypasses HTTP authentication on desktop', () => {
    transportMock.platform = 'darwin'
    render(<OperatorUnlockGate>{child}</OperatorUnlockGate>)
    expect(screen.getByTestId('app')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('renders children for an authenticated cookie', async () => {
    fetchMock.mockResolvedValue(reply(true))
    render(<OperatorUnlockGate>{child}</OperatorUnlockGate>)
    expect(await screen.findByTestId('app')).toBeTruthy()
  })
  it('exchanges a token and checks the resulting session', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(false))
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(reply(true))
    render(<OperatorUnlockGate>{child}</OperatorUnlockGate>)
    fireEvent.change(await screen.findByPlaceholderText('Operator token'), {
      target: { value: 'machine-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByTestId('app')).toBeTruthy()
    expect(fetchMock.mock.calls[1][1].body).toBe(
      JSON.stringify({ token: 'machine-token' })
    )
  })
  it('keeps rejected credentials locked', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(false))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    render(<OperatorUnlockGate>{child}</OperatorUnlockGate>)
    fireEvent.change(await screen.findByPlaceholderText('Operator token'), {
      target: { value: 'bad' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByText(/Invalid operator token/)).toBeTruthy()
  })
  it('offers retry for an unreachable server without pretending the session was revoked', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(reply(true))
    render(<OperatorUnlockGate>{child}</OperatorUnlockGate>)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByTestId('app')).toBeTruthy())
  })
})
