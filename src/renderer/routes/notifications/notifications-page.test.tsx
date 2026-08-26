import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { i18n } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { AppNotification } from '@shared/types/notification'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationsPage } from './notifications-page'

// Mock transport per pending-approvals-section.test.tsx precedent — the page
// talks to the core through Commands/Queries/Events, not window.motrix.
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

function notification(
  overrides: Partial<AppNotification> = {}
): AppNotification {
  return {
    id: 'n1',
    sourceKey: 'src1',
    kind: 'task-error',
    severity: 'error',
    titleKey: 'notification.taskError.title',
    titleParams: { name: 'file.zip' },
    bodyKey: null,
    bodyParams: null,
    taskId: 't1',
    createdAt: Date.now() - 60_000,
    readAt: null,
    ...overrides,
  }
}

function mockList(items: AppNotification[]) {
  vi.mocked(transport.invoke).mockImplementation(async (ch: string) => {
    if (ch === Queries.ListNotifications) return items
    if (ch === Queries.GetUnreadNotificationCount) {
      return items.filter((it) => it.readAt === null).length
    }
    return undefined
  })
}

let location = ''
function LocationSpy() {
  const loc = useLocation()
  location = `${loc.pathname}${loc.search}`
  return null
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/notifications']}>
      <LocationSpy />
      <NotificationsPage />
    </MemoryRouter>
  )
}

describe('<NotificationsPage>', () => {
  beforeEach(() => {
    location = ''
  })
  afterEach(async () => {
    vi.clearAllMocks()
    // Restore the default locale so a later test file sharing this i18n
    // singleton doesn't inherit zh-CN from a language-switch test elsewhere.
    await i18n.changeLanguage('en-US')
  })

  it('renders the Empty state when there are no notifications, without a list role', async () => {
    mockList([])
    renderPage()
    expect(await screen.findByText('No notifications')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Download activity and important app notices will show up here'
      )
    ).toBeInTheDocument()
    // The Empty state isn't a list — the row container must not claim
    // role="list" over zero list items.
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('renders the raw key and warns when titleKey is unknown to the catalog', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockList([
      notification({
        titleKey: 'notification.totallyUnknownKey',
        titleParams: null,
      }),
    ])
    renderPage()
    expect(
      await screen.findByText('notification.totallyUnknownKey')
    ).toBeInTheDocument()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('exposes the row container as a list with a listitem per row', async () => {
    mockList([
      notification({ id: 'n1' }),
      notification({
        id: 'n2',
        titleParams: { name: 'other.zip' },
      }),
    ])
    renderPage()
    await screen.findByText('file.zip failed')

    const list = screen.getByRole('list')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(list.children).toHaveLength(2)
  })

  it('labels the open button with the unread suffix for unread rows and the plain title for read rows', async () => {
    mockList([
      notification({ id: 'n1', readAt: null }),
      notification({
        id: 'n2',
        readAt: Date.now(),
        titleParams: { name: 'other.zip' },
      }),
    ])
    renderPage()
    await screen.findByText('file.zip failed')

    expect(
      screen.getByRole('button', { name: 'file.zip failed (unread)' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'other.zip failed' })
    ).toBeInTheDocument()
  })

  it('marks read and navigates to the task on row click', async () => {
    mockList([notification({ id: 'n1', taskId: 't1' })])
    renderPage()
    const row = await screen.findByText('file.zip failed')
    fireEvent.click(row)
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.MarkNotificationRead,
        'n1'
      )
    )
    await waitFor(() => expect(location).toBe('/downloads/all?task=t1'))
  })

  it('does not navigate when the notification has no taskId', async () => {
    mockList([notification({ id: 'n1', taskId: null })])
    renderPage()
    const row = await screen.findByText('file.zip failed')
    fireEvent.click(row)
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.MarkNotificationRead,
        'n1'
      )
    )
    expect(location).toBe('/notifications')
  })

  it('deletes a single row via its delete command', async () => {
    mockList([notification({ id: 'n1' })])
    renderPage()
    await screen.findByText('file.zip failed')
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.DeleteNotification,
        'n1'
      )
    )
  })

  it('mark-all-read and clear invoke their commands', async () => {
    mockList([notification({ id: 'n1' })])
    renderPage()
    await screen.findByText('file.zip failed')

    fireEvent.click(screen.getByRole('button', { name: /mark all read/i }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.MarkAllNotificationsRead
      )
    )

    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(Commands.ClearNotifications)
    )
  })

  it('refetches the list when a NotificationsChanged event fires', async () => {
    mockList([notification({ id: 'n1' })])
    renderPage()
    await screen.findByText('file.zip failed')

    mockList([notification({ id: 'n2', titleParams: { name: 'other.zip' } })])
    const changedListener = vi
      .mocked(transport.on)
      .mock.calls.find((c) => c[0] === Events.NotificationsChanged)?.[1] as
      | (() => void)
      | undefined
    expect(changedListener).toBeTruthy()
    changedListener?.()

    expect(await screen.findByText('other.zip failed')).toBeInTheDocument()
    expect(screen.queryByText('file.zip failed')).not.toBeInTheDocument()
  })

  it('re-renders with translated copy when the language switches to zh-CN', async () => {
    mockList([notification({ id: 'n1', titleParams: { name: 'file.zip' } })])
    renderPage()
    await screen.findByText('file.zip failed')

    await act(async () => {
      await i18n.changeLanguage('zh-CN')
    })

    expect(await screen.findByText('file.zip 下载失败')).toBeInTheDocument()
    expect(screen.queryByText('file.zip failed')).not.toBeInTheDocument()
  })
})
