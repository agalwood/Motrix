import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PermissionRow } from './permission-row'

describe('PermissionRow', () => {
  it('renders strong + plain for storage permission', () => {
    render(<PermissionRow permission="storage" granted={true} />)
    expect(screen.getByText('Save settings')).toBeInTheDocument()
    expect(screen.getByText('Remembers plugin options.')).toBeInTheDocument()
  })

  it('renders beginner-friendly text for website cookies', () => {
    render(<PermissionRow permission="http.cookies" granted={true} />)
    expect(screen.getByText('Use website cookies')).toBeInTheDocument()
    expect(
      screen.getByText('Accesses sites where you are signed in.')
    ).toBeInTheDocument()
  })

  it('falls back to raw name for unknown permission', () => {
    render(<PermissionRow permission="foo.bar" granted={false} />)
    expect(screen.getByText('foo.bar')).toBeInTheDocument()
    expect(screen.getByText('Unknown permission.')).toBeInTheDocument()
  })

  it('renders an unchecked Switch labelled "Grant" when not granted', () => {
    const onToggle = vi.fn()
    render(
      <PermissionRow
        permission="notifications"
        granted={false}
        onToggle={onToggle}
      />
    )
    const sw = screen.getByRole('switch', { name: 'Allow' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('renders a checked Switch labelled "Allowed" when granted', () => {
    render(
      <PermissionRow
        permission="notifications"
        granted={true}
        onToggle={() => {}}
      />
    )
    const sw = screen.getByRole('switch', { name: 'Allowed' })
    expect(sw).toHaveAttribute('aria-checked', 'true')
  })

  it('hides the toggle when onToggle is not provided', () => {
    render(<PermissionRow permission="storage" granted={true} />)
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
