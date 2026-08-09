import '@renderer/lib/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { transportMock, statusMock, loginMock } = vi.hoisted(() => ({
  transportMock: { platform: 'web' as 'web' | 'electron' },
  statusMock: vi.fn<() => Promise<boolean>>(),
  loginMock: vi.fn<(t: string) => Promise<boolean>>(),
}))

vi.mock('@renderer/lib/transport', () => ({ transport: transportMock }))
vi.mock('@renderer/lib/operator-auth', () => ({
  getOperatorStatus: statusMock,
  operatorLogin: loginMock,
}))

import { OperatorUnlockGate } from './operator-unlock-gate'

const child = <div data-testid="app">APP</div>

describe('OperatorUnlockGate', () => {
  beforeEach(() => {
    transportMock.platform = 'web'
    statusMock.mockReset()
    loginMock.mockReset()
  })

  it('renders children directly on the desktop build (no /rpc)', () => {
    transportMock.platform = 'electron'
    render(<OperatorUnlockGate>{child}</OperatorUnlockGate>)
    expect(screen.getByTestId('app')).toBeTruthy()
    expect(statusMock).not.toHaveBeenCalled()
  })

  it('renders children when already authed (web)', async () => {
    statusMock.mockResolvedValue(true)
    render(<OperatorUnlockGate>{child}</OperatorUnlockGate>)
    expect(await screen.findByTestId('app')).toBeTruthy()
  })

  it('shows the unlock form when locked, then renders children after unlock', async () => {
    statusMock.mockResolvedValue(false)
    loginMock.mockResolvedValue(true)
    render(<OperatorUnlockGate>{child}</OperatorUnlockGate>)
    const input = await screen.findByPlaceholderText('Operator token')
    fireEvent.change(input, { target: { value: 'machine-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByTestId('app')).toBeTruthy()
    expect(loginMock).toHaveBeenCalledWith('machine-token')
  })

  it('shows an error and stays locked when the token is rejected', async () => {
    statusMock.mockResolvedValue(false)
    loginMock.mockResolvedValue(false)
    render(<OperatorUnlockGate>{child}</OperatorUnlockGate>)
    const input = await screen.findByPlaceholderText('Operator token')
    fireEvent.change(input, { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByText(/Invalid operator token/)).toBeTruthy()
    expect(screen.queryByTestId('app')).toBeNull()
  })
})
