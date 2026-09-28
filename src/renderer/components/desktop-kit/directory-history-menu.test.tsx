import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryHistoryMenu } from './directory-history-menu'

const mocks = vi.hoisted(() => ({
  kind: 'electron' as 'electron' | 'web',
  preferences: { favorites: ['/favorite'], recent: ['/recent ', '/current'] },
  locations: {
    common: [],
    favorites: [
      { name: 'allowed', path: '/allowed', sourcePaths: ['/allowed'] },
    ],
    recent: [],
  },
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  appHook: vi.fn(),
  serverHook: vi.fn(),
  managerOpenedFrom: null as Element | null,
}))

vi.mock('@renderer/platform/services', () => ({
  usePlatformServices: () => ({ kind: mocks.kind }),
}))
vi.mock('@renderer/lib/directory-preferences', () => ({
  useDirectoryPreferences: () => {
    mocks.appHook()
    return {
      preferences: mocks.preferences,
      loading: mocks.loading,
      error: mocks.error,
      refresh: mocks.refresh,
    }
  },
  useServerDirectoryLocations: () => {
    mocks.serverHook()
    return {
      locations: mocks.locations,
      loading: mocks.loading,
      error: mocks.error,
      refresh: mocks.refresh,
    }
  },
}))
vi.mock(
  '@renderer/features/directory-preferences/directory-preferences-dialog',
  () => ({
    DirectoryPreferencesDialog: ({
      open,
      onClose,
    }: {
      open: boolean
      onClose: () => void
    }) => {
      if (!open) return null
      mocks.managerOpenedFrom = document.activeElement
      return (
        <div role="dialog" aria-label="Manage directories">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      )
    },
  })
)

describe('DirectoryHistoryMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.kind = 'electron'
    mocks.preferences = {
      favorites: ['/favorite'],
      recent: ['/recent ', '/current'],
    }
    mocks.loading = false
    mocks.error = null
    mocks.managerOpenedFrom = null
    mocks.locations = {
      common: [],
      favorites: [
        { name: 'allowed', path: '/allowed', sourcePaths: ['/allowed'] },
      ],
      recent: [],
    }
  })

  it('shows App favorites before recent with literal paths and current check without Server queries', async () => {
    const onSelect = vi.fn()
    render(<DirectoryHistoryMenu currentPath="/current" onSelect={onSelect} />)
    expect(mocks.appHook).not.toHaveBeenCalled()
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Directory history' }))
    await screen.findByRole('menu')
    expect(mocks.appHook).toHaveBeenCalled()
    expect(mocks.serverHook).not.toHaveBeenCalled()
    expect(
      screen.getAllByRole('menuitem').map((item) => item.textContent)
    ).toEqual(['/favorite', '/recent ', '/current', 'Manage directories'])
    expect(screen.getByRole('menuitem', { name: '/current' })).toHaveAttribute(
      'aria-current',
      'true'
    )
    await userEvent
      .setup()
      .click(screen.getByRole('menuitem', { name: '/recent' }))
    expect(onSelect).toHaveBeenCalledWith('/recent ')
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    )
  })

  it('shows only authorized Server entries without exposing raw saved paths', async () => {
    mocks.kind = 'web'
    render(<DirectoryHistoryMenu currentPath="/allowed" onSelect={vi.fn()} />)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Directory history' }))
    await screen.findByRole('menu')
    expect(mocks.serverHook).toHaveBeenCalled()
    expect(mocks.appHook).not.toHaveBeenCalled()
    expect(
      screen.getByRole('menuitem', { name: '/allowed' })
    ).toBeInTheDocument()
    expect(screen.queryByText('/favorite')).not.toBeInTheDocument()
  })

  it('supports keyboard selection and Escape with trigger focus restoration', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<DirectoryHistoryMenu currentPath="/current" onSelect={onSelect} />)
    const trigger = screen.getByRole('button', { name: 'Directory history' })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: '/favorite' })).toHaveFocus()
    )
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith('/favorite')
    await waitFor(() => expect(trigger).toHaveFocus())
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it.each(['Control', 'Meta'])(
    'contains %s+Enter and Escape before parent window shortcuts',
    async (modifier) => {
      const parent = vi.fn()
      window.addEventListener('keydown', parent)
      try {
        const onSelect = vi.fn()
        const user = userEvent.setup()
        render(
          <DirectoryHistoryMenu currentPath="/current" onSelect={onSelect} />
        )
        await user.click(
          screen.getByRole('button', { name: 'Directory history' })
        )
        await screen.findByRole('menu')
        const first = screen.getByRole('menuitem', { name: '/favorite' })
        first.focus()
        const properties =
          modifier === 'Control' ? { ctrlKey: true } : { metaKey: true }
        parent.mockClear()
        fireEvent.keyDown(first, { key: 'Enter', ...properties })
        expect(parent).not.toHaveBeenCalled()
        expect(onSelect).not.toHaveBeenCalled()
        expect(screen.getByRole('menu')).toBeInTheDocument()
        fireEvent.keyDown(first, { key: 'Escape' })
        expect(parent).not.toHaveBeenCalled()
        await waitFor(() =>
          expect(screen.queryByRole('menu')).not.toBeInTheDocument()
        )
      } finally {
        window.removeEventListener('keydown', parent)
      }
    }
  )

  it('preserves a live manager opener instead of the disappearing menu entry', async () => {
    render(<DirectoryHistoryMenu currentPath="/current" onSelect={vi.fn()} />)
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: 'Directory history' })
    await user.click(trigger)
    await screen.findByRole('menu')
    await user.click(
      screen.getByRole('menuitem', { name: 'Manage directories' })
    )
    expect(
      await screen.findByRole('dialog', { name: 'Manage directories' })
    ).toBeInTheDocument()
    expect(mocks.managerOpenedFrom).toBe(trigger)
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    )
  })

  it('keeps failed locations retryable without selecting an unverified saved path', async () => {
    mocks.kind = 'web'
    mocks.error = 'unavailable'
    mocks.locations = { common: [], favorites: [], recent: [] }
    render(<DirectoryHistoryMenu currentPath="/current" onSelect={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Directory history' }))
    await screen.findByRole('menu')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Retry' }))
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('restores menu focus when a settings event removes its focused record', async () => {
    const props = { currentPath: '/current', onSelect: vi.fn() }
    const view = render(<DirectoryHistoryMenu {...props} />)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Directory history' }))
    await screen.findByRole('menu')
    const item = screen.getByRole('menuitem', { name: '/favorite' })
    act(() => item.focus())
    mocks.preferences = { favorites: [], recent: [] }
    await act(async () => view.rerender(<DirectoryHistoryMenu {...props} />))
    expect(screen.getByRole('menu')).toContainElement(
      document.activeElement as HTMLElement
    )
  })
})
