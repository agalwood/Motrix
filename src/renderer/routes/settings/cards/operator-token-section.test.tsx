import '@test-utils/dom-animations'
import '@testing-library/jest-dom/vitest'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { i18n } from '@renderer/lib/i18n'
import {
  changeOperatorToken,
  useOperatorSession,
} from '@renderer/lib/operator-auth'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OperatorTokenSection } from './operator-token-section'

vi.mock('@renderer/lib/operator-auth', async (original) => ({
  ...(await original<typeof import('@renderer/lib/operator-auth')>()),
  changeOperatorToken: vi.fn(),
}))
beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  useOperatorSession.setState({
    state: 'authenticated',
    status: {
      authed: true,
      mode: 'cookie',
      canLogout: true,
      tokenSource: 'file',
    },
  })
  vi.mocked(changeOperatorToken).mockReset()
})
afterEach(cleanup)

function Harness() {
  const [open, setOpen] = useState(true)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogTitle>Advanced settings</DialogTitle>
        <OperatorTokenSection />
      </DialogContent>
    </Dialog>
  )
}

async function edit(next = '1', confirmation = next) {
  render(<Harness />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Change password' }))
  fireEvent.change(screen.getByLabelText('Current password'), {
    target: { value: 'original' },
  })
  fireEvent.change(screen.getByLabelText('New password'), {
    target: { value: next },
  })
  fireEvent.blur(screen.getByLabelText('New password'))
  fireEvent.change(screen.getByLabelText('Confirm new password'), {
    target: { value: confirmation },
  })
  return user
}

it('warns about a weak token but saves it without another confirmation', async () => {
  vi.mocked(changeOperatorToken).mockResolvedValue({ ok: true })
  const user = await edit()
  expect(screen.getByText(/public internet/)).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Update password' }))
  expect(changeOperatorToken).toHaveBeenCalledWith('original', '1')
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Access password updated'
  )
  expect(screen.queryByLabelText('New password')).toBeNull()
})

it('does not send mismatched entries and lets the user correct them', async () => {
  const user = await edit('one', 'two')
  await user.click(screen.getByRole('button', { name: 'Update password' }))
  expect(await screen.findByText('The passwords do not match.')).toBeVisible()
  expect(changeOperatorToken).not.toHaveBeenCalled()
})

it('reports a failed write without dismissing the form or claiming success', async () => {
  vi.mocked(changeOperatorToken).mockResolvedValue({
    ok: false,
    reason: 'unavailable',
  })
  const user = await edit()
  await user.click(screen.getByRole('button', { name: 'Update password' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'current password still works'
  )
  expect(screen.getByLabelText('New password')).toHaveValue('1')
})

it('shows deployment guidance for environment tokens and hides the section for NAS', () => {
  useOperatorSession.setState({
    status: {
      authed: true,
      mode: 'cookie',
      canLogout: true,
      tokenSource: 'env',
    },
  })
  const view = render(<Harness />)
  expect(screen.getByText(/managed by the server administrator/)).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull()
  view.unmount()
  useOperatorSession.setState({
    status: { authed: true, mode: 'synologyDsm', canLogout: false },
  })
  render(<Harness />)
  expect(screen.queryByText('Access password')).toBeNull()
})

it('adds its own backdrop and discards only its draft on cancel, restoring trigger focus', async () => {
  const user = await edit()
  expect(document.querySelectorAll('[role=dialog]')).toHaveLength(2)
  expect(document.querySelectorAll('[data-slot=dialog-overlay]')).toHaveLength(
    2
  )
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByLabelText('New password')).toBeNull()
  expect(
    screen.getByRole('dialog', { name: 'Advanced settings' })
  ).toBeVisible()
  expect(changeOperatorToken).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Change password' })).toHaveFocus()
  await user.click(screen.getByRole('button', { name: 'Change password' }))
  expect(screen.getByLabelText('Current password')).toHaveValue('')
  expect(screen.getByLabelText('New password')).toHaveValue('')
  expect(screen.queryByText(/public internet/)).toBeNull()
})

it('does not show weakness feedback until the new password field loses focus', async () => {
  render(<Harness />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Change password' }))
  fireEvent.change(screen.getByLabelText('New password'), {
    target: { value: '1' },
  })
  expect(screen.queryByText(/public internet/)).toBeNull()
  fireEvent.blur(screen.getByLabelText('New password'))
  expect(screen.getByText(/public internet/)).toBeVisible()
})

it('Escape dismisses the password dialog while keeping the parent open', async () => {
  const user = await edit()
  await user.keyboard('{Escape}')
  expect(screen.queryByLabelText('New password')).toBeNull()
  expect(
    screen.getByRole('dialog', { name: 'Advanced settings' })
  ).toBeVisible()
})
