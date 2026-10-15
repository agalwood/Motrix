import type { MdxpTask } from '@motrix/mdxp'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlPanel } from '@/popup/ControlPanel'
import { createPreviewTasks } from '@/popup/previewTasks'
import type { ControlPanel as ControlPanelController } from '@/popup/useControlPanel'
import { i18n } from '@/shared/i18n'

function task(
  id: string,
  name: string,
  status: MdxpTask['status'],
  createdAt: number
): MdxpTask {
  return {
    id,
    type: 'http',
    name,
    status,
    progress: status === 'completed' ? 1 : 0.5,
    bytesDone: 512,
    bytesTotal: 1024,
    speedBps: status === 'downloading' ? 2048 : 0,
    etaSec: null,
    saveDir: '/downloads',
    error: status === 'error' ? 'network failed' : null,
    createdAt,
    finishedAt: status === 'completed' ? createdAt + 1 : null,
    finalPath: status === 'completed' ? `/downloads/${name}` : null,
  }
}

function controller(): ControlPanelController {
  return {
    tasks: [
      task('active-1', 'active.iso', 'downloading', 3),
      task('failed-1', 'failed.iso', 'error', 2),
      task('recent-1', 'recent.iso', 'completed', 1),
    ],
    stats: null,
    engine: null,
    loading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    reveal: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  }
}

function panelForTab(name: string): HTMLElement {
  const panelId = screen
    .getByRole('tab', { name })
    .getAttribute('aria-controls')
  const panel = panelId ? document.getElementById(panelId) : null
  if (!panel) throw new Error(`Missing tab panel for ${name}`)
  return panel
}

describe('ControlPanel task views', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('filters active, failed, and recent tasks', () => {
    const activeLabel = i18n.t('popup.tasks.filters.active')
    const failedLabel = i18n.t('popup.tasks.filters.failed')
    const recentLabel = i18n.t('popup.tasks.filters.recent')

    render(
      <ControlPanel
        connection="connected"
        controller={controller()}
        onReconnect={vi.fn()}
      />
    )

    let panel = panelForTab(activeLabel)
    expect(within(panel).getByText('active.iso')).toBeTruthy()
    expect(within(panel).queryByText('failed.iso')).toBeNull()
    expect(within(panel).queryByText('recent.iso')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: failedLabel }))
    panel = panelForTab(failedLabel)
    expect(within(panel).getByText('failed.iso')).toBeTruthy()
    expect(within(panel).queryByText('active.iso')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: recentLabel }))
    panel = panelForTab(recentLabel)
    expect(within(panel).getByText('recent.iso')).toBeTruthy()
    expect(within(panel).queryByText('failed.iso')).toBeNull()
  })

  it('matches the compact toolbar, segmented filter, card, and row geometry', () => {
    render(
      <ControlPanel
        connection="connected"
        controller={controller()}
        onReconnect={vi.fn()}
      />
    )

    const toolbar = screen.getByTestId('compact-section-toolbar')
    expect(toolbar.className).toContain('h-8')

    const tablist = screen.getByRole('tablist')
    expect(tablist.className).toContain('h-8')
    expect(tablist.className).toContain('min-w-0')
    expect(tablist.className).toContain('flex-1')
    expect(tablist.className).toContain('rounded-[10px]')
    expect(tablist.className).toContain('bg-tab-background')

    const tabs = screen.getAllByRole('tab')
    for (const tab of tabs) {
      expect(tab.className).toContain('h-7')
      expect(tab.className).toContain('w-auto')
      expect(tab.className).toContain('min-w-0')
      expect(tab.className).toContain('flex-auto')
      expect(tab.className).toContain('border-0')
      expect(tab.className).toContain('px-2')
      expect(tab.className).toContain('text-[11px]')
      expect(tab.className).toContain(
        'group-data-[variant=default]/tabs-list:data-active:shadow-xs'
      )
    }
    const card = screen.getByTestId('task-card')
    expect(card.className).toContain('flex-1')
    expect(card.className).toContain('min-h-48')
    expect(card.className).toContain('rounded-[12px]')
    expect(card.className).toContain('border-border')
    expect(card.className).toContain('shadow-card')

    const row = screen.getByTestId('task-row-active-1')
    expect(row.className).toContain('h-[74px]')
    expect(row.className).toContain('after:inset-x-4')
    expect(row.className).not.toMatch(/rounded-(md|lg|xl)/)

    const history = screen.getByRole('button', {
      name: `${i18n.t('popup.tasks.filters.recent')} (1)`,
    })
    expect(history.className).toContain('h-11')
  })

  it('sorts each view newest first and links the footer to completed history', async () => {
    const control = controller()
    control.tasks = [
      task('older', 'older.iso', 'downloading', 1),
      task('recent-1', 'recent.iso', 'completed', 2),
      task('newer', 'newer.iso', 'queued', 3),
    ]
    const user = userEvent.setup()

    render(
      <ControlPanel
        connection="connected"
        controller={control}
        onReconnect={vi.fn()}
      />
    )

    const activePanel = panelForTab(i18n.t('popup.tasks.filters.active'))
    expect(
      within(activePanel)
        .getAllByTestId(/^task-row-/)
        .map((row) => row.getAttribute('data-testid'))
    ).toEqual(['task-row-newer', 'task-row-older'])

    await user.click(
      screen.getByRole('button', {
        name: `${i18n.t('popup.tasks.filters.recent')} (1)`,
      })
    )

    const completedTab = screen.getByRole('tab', {
      name: i18n.t('popup.tasks.filters.recent'),
    })
    expect(completedTab.getAttribute('data-active')).not.toBeNull()
    expect(
      within(panelForTab(i18n.t('popup.tasks.filters.recent'))).getByText(
        'recent.iso'
      )
    ).toBeTruthy()
  })

  it('keeps action nodes and focus stable while live progress is repainted', () => {
    const control = controller()
    control.tasks = [task('active-1', 'active.iso', 'downloading', 1)]
    const onReconnect = vi.fn()
    const view = render(
      <ControlPanel
        connection="connected"
        controller={control}
        canRevealTask
        onReconnect={onReconnect}
      />
    )
    const remove = screen.getByRole('button', { name: 'Remove active.iso' })
    const identity = screen.getByText('active.iso')
    remove.focus()

    const updated = {
      ...control.tasks[0],
      progress: 0.75,
      bytesDone: 768,
      speedBps: 4096,
    }
    view.rerender(
      <ControlPanel
        connection="connected"
        controller={{ ...control, tasks: [updated] }}
        canRevealTask
        onReconnect={onReconnect}
      />
    )

    expect(screen.getByRole('button', { name: 'Remove active.iso' })).toBe(
      remove
    )
    expect(screen.getByText('active.iso')).toBe(identity)
    expect(document.activeElement).toBe(remove)
    expect(screen.getByText(/768 B of 1\.0 KB/)).toBeTruthy()
  })

  it('reuses the transfer button when pause changes to resume', () => {
    const control = controller()
    control.tasks = [task('active-1', 'active.iso', 'downloading', 1)]
    const onReconnect = vi.fn()
    const view = render(
      <ControlPanel
        connection="connected"
        controller={control}
        onReconnect={onReconnect}
      />
    )
    const transfer = screen.getByRole('button', { name: 'Pause active.iso' })
    transfer.focus()

    view.rerender(
      <ControlPanel
        connection="connected"
        controller={{
          ...control,
          tasks: [task('active-1', 'active.iso', 'paused', 1)],
        }}
        onReconnect={onReconnect}
      />
    )

    expect(screen.getByRole('button', { name: 'Resume active.iso' })).toBe(
      transfer
    )
    expect(document.activeElement).toBe(transfer)
  })

  it('dispatches visible pause, resume, and remove icons without revealing the row', async () => {
    const control = controller()
    const user = userEvent.setup()
    render(
      <ControlPanel
        connection="connected"
        controller={control}
        canRevealTask
        onReconnect={vi.fn()}
      />
    )

    const pause = screen.getByRole('button', { name: 'Pause active.iso' })
    expect(pause.getAttribute('title')).toBe('Pause active.iso')
    await user.click(pause)
    await waitFor(() => expect(control.pause).toHaveBeenCalledWith('active-1'))
    expect(control.reveal).not.toHaveBeenCalled()

    const remove = screen.getByRole('button', { name: 'Remove active.iso' })
    expect(remove.getAttribute('title')).toBe('Remove active.iso')
    await user.click(remove)
    expect(control.remove).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(
      screen.getByText('“active.iso” will be removed from the download list.')
    ).toBeTruthy()
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Delete downloaded files',
        }) as HTMLInputElement
      ).checked
    ).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(control.remove).toHaveBeenCalledWith('active-1', false)
    )
    expect(control.reveal).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole('tab', { name: i18n.t('popup.tasks.filters.failed') })
    )
    const resume = screen.getByRole('button', { name: 'Resume failed.iso' })
    expect(resume.getAttribute('title')).toBe('Resume failed.iso')
    await user.click(resume)
    await waitFor(() => expect(control.resume).toHaveBeenCalledWith('failed-1'))
    expect(control.reveal).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull()
  })

  it('cancels task removal without calling the backend', async () => {
    const control = controller()
    const user = userEvent.setup()
    render(
      <ControlPanel
        connection="connected"
        controller={control}
        onReconnect={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Remove active.iso' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(control.remove).not.toHaveBeenCalled()
  })

  it.each(['en-US', 'zh-TW', 'ar'])(
    'preserves the full magnet filename in the %s removal confirmation',
    async (language) => {
      await i18n.changeLanguage(language)
      const control = controller()
      const magnet = createPreviewTasks('worst')[0]!
      control.tasks = [magnet]
      const user = userEvent.setup()
      render(
        <ControlPanel
          connection="connected"
          controller={control}
          onReconnect={vi.fn()}
        />
      )

      await user.click(
        screen.getByRole('button', {
          name: i18n.t('popup.tasks.removeTask', { name: magnet.name }),
        })
      )
      const dialog = screen.getByRole('alertdialog')
      const description = document.getElementById(
        dialog.getAttribute('aria-describedby') ?? ''
      )
      expect(description?.textContent).toBe(
        i18n.t('popup.tasks.removeConfirmDescription', { name: magnet.name })
      )
      expect(control.remove).not.toHaveBeenCalled()

      await user.click(
        within(dialog).getByRole('checkbox', {
          name: i18n.t('popup.tasks.removeDeleteFilesLabel'),
        })
      )
      await user.click(
        within(dialog).getByRole('button', {
          name: i18n.t('popup.tasks.removeConfirmAction'),
        })
      )
      await waitFor(() =>
        expect(control.remove).toHaveBeenCalledExactlyOnceWith(magnet.id, true)
      )
    }
  )

  it.each(['', '   '])(
    'identifies an unnamed task (%j) by ID before confirming removal',
    async (name) => {
      const control = controller()
      control.tasks = [task('unnamed-task', name, 'downloading', 1)]
      const user = userEvent.setup()
      render(
        <ControlPanel
          connection="connected"
          controller={control}
          onReconnect={vi.fn()}
        />
      )
      expect(screen.getByText('unnamed-task')).toBeTruthy()
      await user.click(
        screen.getByRole('button', { name: 'Remove unnamed-task' })
      )
      expect(
        within(screen.getByRole('alertdialog')).getByText(
          '“unnamed-task” will be removed from the download list.'
        )
      ).toBeTruthy()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(control.remove).not.toHaveBeenCalled()
    }
  )

  it('deletes downloaded files only after explicit opt-in', async () => {
    const control = controller()
    const user = userEvent.setup()
    render(
      <ControlPanel
        connection="connected"
        controller={control}
        onReconnect={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Remove active.iso' }))
    await user.click(
      screen.getByRole('checkbox', { name: 'Delete downloaded files' })
    )
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(control.remove).toHaveBeenCalledWith('active-1', true)
    )
  })

  it('keeps the removal confirmation open and controls disabled while saving', async () => {
    const control = controller()
    let finishRemoval!: () => void
    vi.mocked(control.remove).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRemoval = resolve
        })
    )
    const user = userEvent.setup()
    render(
      <ControlPanel
        connection="connected"
        controller={control}
        onReconnect={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Remove active.iso' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = screen.getByRole('alertdialog')
    expect(
      (
        within(dialog).getByRole('button', {
          name: 'Cancel',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(
      (
        within(dialog).getByRole('button', {
          name: /Remove$/,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(
      (within(dialog).getByRole('checkbox') as HTMLInputElement).disabled
    ).toBe(true)
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBe(dialog)
    expect(control.remove).toHaveBeenCalledExactlyOnceWith('active-1', false)
    await act(async () => {
      finishRemoval()
    })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('keeps the task visible and reports a rejected removal', async () => {
    const control = controller()
    vi.mocked(control.remove).mockRejectedValue(
      new Error('Task removal failed')
    )
    const user = userEvent.setup()
    render(
      <ControlPanel
        connection="connected"
        controller={control}
        onReconnect={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Remove active.iso' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByRole('alert').textContent).toContain(
      'Task removal failed'
    )
    expect(screen.getByText('active.iso')).toBeTruthy()
  })

  it('preselects file deletion when the remove action is shift-clicked', async () => {
    const control = controller()
    render(
      <ControlPanel
        connection="connected"
        controller={control}
        onReconnect={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove active.iso' }), {
      shiftKey: true,
    })

    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Delete downloaded files',
        }) as HTMLInputElement
      ).checked
    ).toBe(true)
    expect(control.remove).not.toHaveBeenCalled()
  })

  it.each(['active', 'failed', 'recent'] as const)(
    'links to the exact %s task details and reveals only from its folder icon',
    async (view) => {
      const control = controller()
      const user = userEvent.setup()
      render(
        <ControlPanel
          connection="connected"
          controller={control}
          canRevealTask
          canOpenApp
          onReconnect={vi.fn()}
        />
      )
      await user.click(
        screen.getByRole('tab', { name: i18n.t(`popup.tasks.filters.${view}`) })
      )

      const taskAction = screen.getByRole('link', {
        name: `View task details in Motrix App: ${view}.iso`,
      })
      expect(taskAction.getAttribute('href')).toBe(`motrix://tasks/${view}-1`)
      // Observe the browser handoff without navigating jsdom to a custom URL.
      const navigate = vi.fn((event: Event) => event.preventDefault())
      taskAction.addEventListener('click', navigate)
      await user.click(taskAction)
      expect(navigate).toHaveBeenCalledOnce()
      expect(control.reveal).not.toHaveBeenCalled()

      navigate.mockClear()
      await user.keyboard('{Enter}')
      expect(navigate).toHaveBeenCalledOnce()
      expect(control.reveal).not.toHaveBeenCalled()

      navigate.mockClear()
      const folder = screen.getByTestId(`task-reveal-${view}-1`)
      expect(folder.getAttribute('title')).toBe(
        `Open the folder containing ${view}.iso`
      )
      await user.click(folder)
      await waitFor(() =>
        expect(control.reveal).toHaveBeenCalledExactlyOnceWith(`${view}-1`)
      )
      expect(navigate).not.toHaveBeenCalled()
      expect(control.pause).not.toHaveBeenCalled()
      expect(control.remove).not.toHaveBeenCalled()
    }
  )

  it('does not open a local App for a remote task even when folder reveal is supported', async () => {
    const control = controller()
    const user = userEvent.setup()
    render(
      <ControlPanel
        connection="connected"
        controller={control}
        canRevealTask
        canOpenApp={false}
        onReconnect={vi.fn()}
      />
    )
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByTestId('task-main-active-1')).toBeNull()
    await user.click(screen.getByTestId('task-reveal-active-1'))
    expect(control.reveal).toHaveBeenCalledExactlyOnceWith('active-1')
  })

  it('opens a local App even when folder reveal is unsupported', () => {
    render(
      <ControlPanel
        connection="connected"
        controller={controller()}
        canOpenApp
        onReconnect={vi.fn()}
      />
    )
    expect(
      screen
        .getByRole('link', {
          name: 'View task details in Motrix App: active.iso',
        })
        .getAttribute('href')
    ).toBe('motrix://tasks/active-1')
    expect(
      screen.getByTestId('task-reveal-active-1').getAttribute('aria-disabled')
    ).toBe('true')
  })

  it('encodes opaque task IDs without turning them into URL paths or query parameters', () => {
    const control = controller()
    control.tasks = [task('任务/一?#&%', 'special.iso', 'completed', 1)]
    render(
      <ControlPanel
        connection="connected"
        controller={control}
        canOpenApp
        onReconnect={vi.fn()}
      />
    )
    fireEvent.click(
      screen.getByRole('tab', { name: i18n.t('popup.tasks.filters.recent') })
    )
    expect(
      screen
        .getByRole('link', {
          name: 'View task details in Motrix App: special.iso',
        })
        .getAttribute('href')
    ).toBe(`motrix://tasks/${encodeURIComponent('任务/一?#&%')}`)
  })

  it('keeps unsupported rows non-actionable and exposes the disabled reason', async () => {
    const control = controller()
    const user = userEvent.setup()
    render(
      <ControlPanel
        connection="connected"
        controller={control}
        onReconnect={vi.fn()}
      />
    )

    expect(
      screen.queryByRole('button', {
        name: 'Open the folder containing active.iso',
      })
    ).toBeNull()
    const unsupported = screen.getByRole('button', {
      name: 'Update Motrix to open folders',
    }) as HTMLButtonElement
    expect(unsupported.disabled).toBe(false)
    expect(unsupported.getAttribute('aria-disabled')).toBe('true')
    expect(unsupported.getAttribute('title')).toBe(
      'Update Motrix to open folders'
    )
    unsupported.focus()
    expect(document.activeElement).toBe(unsupported)
    await user.click(unsupported)
    expect(
      screen.getByRole('button', { name: 'Pause active.iso' })
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Remove active.iso' })
    ).toBeTruthy()
    expect(control.reveal).not.toHaveBeenCalled()
  })

  it('disables folder reveal while task metadata is pending but keeps other actions', async () => {
    const control = controller()
    const user = userEvent.setup()
    control.tasks = [task('metadata', 'metadata.iso', 'fetching_metadata', 1)]
    render(
      <ControlPanel
        connection="connected"
        controller={control}
        canRevealTask
        canOpenApp
        onReconnect={vi.fn()}
      />
    )

    const mainAction = screen.getByTestId('task-main-metadata')
    expect(mainAction.getAttribute('href')).toBe('motrix://tasks/metadata')
    expect(mainAction.getAttribute('tabindex')).toBe('0')
    const folder = screen.getByTestId(
      'task-reveal-metadata'
    ) as HTMLButtonElement
    expect(folder.disabled).toBe(false)
    expect(folder.getAttribute('aria-disabled')).toBe('true')
    expect(folder.getAttribute('aria-label')).toBe(
      'Wait for task metadata before opening the folder'
    )
    expect(folder.getAttribute('title')).toBe(
      'Wait for task metadata before opening the folder'
    )
    expect(
      screen.getByRole('button', { name: 'Pause metadata.iso' })
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Remove metadata.iso' })
    ).toBeTruthy()
    await user.click(folder)
    expect(control.reveal).not.toHaveBeenCalled()
  })

  it('keeps the task body mounted when metadata becomes ready', () => {
    const control = controller()
    control.tasks = [task('metadata', 'metadata.iso', 'fetching_metadata', 1)]
    const onReconnect = vi.fn()
    const view = render(
      <ControlPanel
        connection="connected"
        controller={control}
        canRevealTask
        canOpenApp
        onReconnect={onReconnect}
      />
    )
    const mainAction = screen.getByTestId('task-main-metadata')

    view.rerender(
      <ControlPanel
        connection="connected"
        controller={{
          ...control,
          tasks: [task('metadata', 'metadata.iso', 'downloading', 1)],
        }}
        canRevealTask
        canOpenApp
        onReconnect={onReconnect}
      />
    )

    const readyAction = screen.getByTestId('task-main-metadata')
    expect(readyAction).toBe(mainAction)
    expect(readyAction.getAttribute('aria-hidden')).toBeNull()
    expect(readyAction.getAttribute('tabindex')).toBe('0')
  })

  it('keeps focus on the folder button and the App link available while revealing', async () => {
    const control = controller()
    control.tasks = [task('active-1', 'active.iso', 'downloading', 1)]
    let finishReveal!: () => void
    vi.mocked(control.reveal).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishReveal = resolve
        })
    )
    const user = userEvent.setup()
    render(
      <ControlPanel
        connection="connected"
        controller={control}
        canRevealTask
        canOpenApp
        onReconnect={vi.fn()}
      />
    )

    const mainAction = screen.getByTestId(
      'task-reveal-active-1'
    ) as HTMLButtonElement
    await user.click(mainAction)
    await waitFor(() =>
      expect(mainAction.getAttribute('aria-busy')).toBe('true')
    )

    expect(mainAction.disabled).toBe(false)
    expect(mainAction.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(mainAction)
    expect(
      screen
        .getByRole('link', {
          name: 'View task details in Motrix App: active.iso',
        })
        .getAttribute('aria-disabled')
    ).toBeNull()

    await act(async () => finishReveal())
    await waitFor(() => expect(mainAction.getAttribute('aria-busy')).toBeNull())
  })

  it('shows localized reveal failure copy without exposing the RPC error', async () => {
    const control = controller()
    vi.mocked(control.reveal).mockRejectedValueOnce(
      new Error('resource path /Users/private/download.iso was rejected')
    )
    const user = userEvent.setup()
    render(
      <ControlPanel
        connection="connected"
        controller={control}
        canRevealTask
        onReconnect={vi.fn()}
      />
    )

    await user.click(screen.getByTestId('task-reveal-active-1'))

    expect(
      await screen.findByText("Couldn't open the task folder. Try again.")
    ).toBeTruthy()
    expect(screen.queryByText(/Users\/private/)).toBeNull()
  })

  it('disables reveal only for the task whose request is in flight', async () => {
    const control = controller()
    control.tasks = [
      task('active-1', 'active.iso', 'downloading', 2),
      task('active-2', 'another.iso', 'downloading', 1),
    ]
    let finishReveal!: () => void
    vi.mocked(control.reveal).mockImplementation(async (taskId) => {
      if (taskId !== 'active-1') return
      await new Promise<void>((resolve) => {
        finishReveal = resolve
      })
    })
    const user = userEvent.setup()
    render(
      <ControlPanel
        connection="connected"
        controller={control}
        canRevealTask
        onReconnect={vi.fn()}
      />
    )

    const activeReveal = screen.getByTestId(
      'task-reveal-active-1'
    ) as HTMLButtonElement
    const otherReveal = screen.getByTestId(
      'task-reveal-active-2'
    ) as HTMLButtonElement
    await user.click(activeReveal)

    await waitFor(() =>
      expect(activeReveal.getAttribute('aria-disabled')).toBe('true')
    )
    expect(otherReveal.getAttribute('aria-disabled')).toBeNull()
    expect(
      (
        screen.getByRole('button', {
          name: 'Pause active.iso',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
    expect(
      (
        screen.getByRole('button', {
          name: 'Remove active.iso',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)

    await user.click(otherReveal)
    expect(control.reveal).toHaveBeenCalledWith('active-2')

    await act(async () => finishReveal())
    await waitFor(() =>
      expect(activeReveal.getAttribute('aria-disabled')).toBeNull()
    )
  })

  it('keeps translated status metadata and surfaces task action errors', async () => {
    const control = controller()
    vi.mocked(control.pause).mockRejectedValueOnce(new Error('pause failed'))
    const user = userEvent.setup()

    render(
      <ControlPanel
        connection="connected"
        controller={control}
        onReconnect={vi.fn()}
      />
    )

    expect(screen.getByText(/Downloading/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Pause active.iso' }))

    expect(await screen.findByText('pause failed')).toBeTruthy()
  })

  it('places an optional connection notice inside the compact content card', () => {
    render(
      <ControlPanel
        connection="connected"
        controller={controller()}
        onReconnect={vi.fn()}
        notice={<div data-testid="connection-notice">Reconnecting…</div>}
      />
    )

    expect(
      screen
        .getByTestId('task-card')
        .contains(screen.getByTestId('connection-notice'))
    ).toBe(true)
  })

  it('renders a quiet, non-actionable empty state for an empty task view', () => {
    const control = controller()
    control.tasks = []

    render(
      <ControlPanel
        connection="connected"
        controller={control}
        onReconnect={vi.fn()}
      />
    )

    const emptyState = screen.getByRole('status')
    expect(
      within(emptyState).getByText(i18n.t('popup.tasks.empty.active'))
    ).toBeTruthy()
    expect(emptyState.querySelector('.lucide-inbox')).not.toBeNull()
    expect(within(emptyState).queryByRole('button')).toBeNull()
  })

  it('shows a pending state without a duplicate connect action while connecting', () => {
    render(
      <ControlPanel
        connection="connecting"
        controller={controller()}
        onReconnect={vi.fn()}
      />
    )

    const connectingLabel = i18n.t('popup.status.connecting')
    expect(screen.getByRole('status', { name: connectingLabel })).toBeTruthy()
    expect(screen.getByText(connectingLabel)).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: i18n.t('popup.reconnect') })
    ).toBeNull()
  })

  it('hides task filters and diagnostics while offline and reconnects', async () => {
    const onReconnect = vi.fn()
    const user = userEvent.setup()

    render(
      <ControlPanel
        connection="disconnected"
        controller={controller()}
        onReconnect={onReconnect}
      />
    )

    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByText('motrix-not-running')).toBeNull()
    expect(
      screen.getByText(i18n.t('popup.tasks.disconnectedTitle'))
    ).toBeTruthy()

    await user.click(
      screen.getByRole('button', { name: i18n.t('popup.reconnect') })
    )
    expect(onReconnect).toHaveBeenCalledOnce()
  })
})

it('keeps stale task data and filters accessible while disabling task operations', async () => {
  const controls = controller()
  render(
    <ControlPanel
      connection="connected"
      controller={controls}
      canRevealTask
      readOnly
      onReconnect={vi.fn()}
    />
  )
  expect(screen.getByText('active.iso')).toBeTruthy()
  expect(
    screen.getByTestId('task-transfer-active-1').hasAttribute('disabled')
  ).toBe(true)
  expect(
    screen.getByTestId('task-reveal-active-1').getAttribute('aria-disabled')
  ).toBe('true')
  await userEvent.click(
    screen.getByRole('tab', { name: i18n.t('popup.tasks.filters.failed') })
  )
  expect(screen.getByText('failed.iso')).toBeTruthy()
  expect(controls.pause).not.toHaveBeenCalled()
})
