import '@renderer/lib/i18n'
import { applyRendererLocale } from '@renderer/lib/i18n'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WebConnectionNotice } from './web-connection-notice'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    platform: 'web',
    getConnectionState: vi.fn(() => 'disconnected'),
    onConnectionChange: vi.fn(() => () => {}),
  },
}))

beforeEach(async () => {
  vi.clearAllMocks()
  await applyRendererLocale('en-US')
  vi.useFakeTimers()
  useOperatorSession.setState({
    state: 'authenticated',
    status: { authed: true, mode: 'cookie', canLogout: true },
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('stays quiet during brief reconnects and shows sustained loss across repeated retries', () => {
  render(<WebConnectionNotice />)
  expect(screen.queryByRole('status')).toBeNull()
  const listener = vi.mocked(transport.onConnectionChange!).mock.calls[0][0]
  act(() => {
    vi.advanceTimersByTime(3000)
    listener({ state: 'connecting' })
    listener({ state: 'disconnected' })
  })
  expect(screen.queryByRole('status')).toBeNull()
  act(() => vi.advanceTimersByTime(2000))
  expect(screen.getByRole('status').textContent).toContain(
    'Real-time updates are disconnected.'
  )
  act(() => listener({ state: 'connected' }))
  expect(screen.queryByRole('status')).toBeNull()
})

it('immediately explains a diagnosed origin mismatch and hides after logout', () => {
  useOperatorSession.setState({
    status: {
      authed: true,
      mode: 'cookie',
      canLogout: true,
      eventOriginMatches: false,
    },
  })
  render(<WebConnectionNotice />)
  expect(screen.getByRole('status').textContent).toContain(
    'The server access address does not match.'
  )
  act(() => useOperatorSession.setState({ state: 'locked' }))
  expect(screen.queryByRole('status')).toBeNull()
})
