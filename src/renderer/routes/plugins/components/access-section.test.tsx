import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AccessSection } from './access-section'

describe('AccessSection', () => {
  it('renders granted permissions section', () => {
    render(
      <AccessSection
        manifest={
          {
            permissions: ['storage'],
            optionalPermissions: [],
            hostPermissions: [],
          } as never
        }
        grants={{}}
      />
    )
    expect(
      screen.getByText('What this plugin can already do')
    ).toBeInTheDocument()
    expect(screen.getByText('Save settings')).toBeInTheDocument()
  })

  it('shows optional section when ungranted optionals exist', () => {
    render(
      <AccessSection
        manifest={
          {
            permissions: [],
            optionalPermissions: ['notifications'],
            hostPermissions: [],
          } as never
        }
        grants={{ notifications: 'denied' }}
      />
    )
    expect(screen.getByText('Optional access')).toBeInTheDocument()
    expect(screen.getByText('Send notifications')).toBeInTheDocument()
  })

  it('renders an interactive toggle for a community plugin optional permission', () => {
    const onToggleGrant = vi.fn()
    render(
      <AccessSection
        manifest={
          {
            permissions: [],
            optionalPermissions: ['notifications'],
            hostPermissions: [],
          } as never
        }
        grants={{}}
        onToggleGrant={onToggleGrant}
      />
    )
    expect(screen.getAllByRole('switch')).toHaveLength(1)
  })

  it('renders trusted (builtin/dev) optional permissions read-only with no toggle', () => {
    const onToggleGrant = vi.fn()
    render(
      <AccessSection
        manifest={
          {
            permissions: [],
            optionalPermissions: ['notifications'],
            hostPermissions: [],
          } as never
        }
        grants={{}}
        onToggleGrant={onToggleGrant}
        trusted
      />
    )
    // Trusted plugins get every permission by construction → the optional
    // permission shows but with NO switch (so the rejected updateGrants
    // command can never be invoked from here).
    expect(screen.getByText('Send notifications')).toBeInTheDocument()
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
  })

  it('shows broad host warning when broad', () => {
    render(
      <AccessSection
        manifest={
          {
            permissions: [],
            optionalPermissions: [],
            hostPermissions: ['*://*/*'],
          } as never
        }
        grants={{}}
      />
    )
    expect(
      screen.getByText(/can read and modify downloads from any URL/i)
    ).toBeInTheDocument()
  })
})
