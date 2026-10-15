import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/popup/DownloadDirectoryField', () => ({
  DownloadDirectoryField: () => null,
}))

vi.mock('@/background/MessageBus', () => ({ send: vi.fn() }))

import * as MessageBus from '@/background/MessageBus'
import { QuickAddTaskDialog } from '@/popup/QuickAddTaskDialog'
import { QUICK_ADD_TASK_SESSION_KEY } from '@/popup/useQuickAddTask'
import { i18n } from '@/shared/i18n'

const send = vi.mocked(MessageBus.send)

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('QuickAddTaskDialog', () => {
  beforeEach(async () => {
    send.mockReset()
    await i18n.changeLanguage('en-US')
  })

  it('matches the compact dialog structure and focuses the URL input', async () => {
    render(
      <QuickAddTaskDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />
    )

    const dialog = screen.getByRole('dialog', {
      name: i18n.t('popup.quickAdd.title'),
    })
    expect(dialog.className).toContain('max-w-[376px]')

    const input = screen.getByRole('textbox', {
      name: i18n.t('popup.quickAdd.inputLabel'),
    })
    expect(input.tagName).toBe('TEXTAREA')
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(input.getAttribute('aria-describedby')).toContain(
      'quick-add-task-description'
    )
  })

  it('submits from the primary action, reports the task, and closes after success', async () => {
    send.mockResolvedValue({ taskId: 'task-created' })
    const onCreated = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <QuickAddTaskDialog
        open
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />
    )

    await userEvent.type(
      screen.getByRole('textbox', {
        name: i18n.t('popup.quickAdd.inputLabel'),
      }),
      'https://example.com/file.zip'
    )
    await userEvent.click(
      screen.getByRole('button', { name: i18n.t('popup.quickAdd.add') })
    )

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('task-created'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows stable validation copy and clears it when the input changes', async () => {
    render(
      <QuickAddTaskDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />
    )
    const input = screen.getByRole('textbox', {
      name: i18n.t('popup.quickAdd.inputLabel'),
    })

    await userEvent.type(input, 'ftp://example.com/file.zip')
    await userEvent.click(
      screen.getByRole('button', { name: i18n.t('popup.quickAdd.add') })
    )

    expect(screen.getByRole('alert').textContent).toBe(
      i18n.t('popup.quickAdd.error.unsupported')
    )
    expect(send).not.toHaveBeenCalled()

    await userEvent.type(input, '?changed')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps failed input for retry without exposing the raw RPC error', async () => {
    send.mockRejectedValue(new Error('secret native path /Users/example'))
    render(
      <QuickAddTaskDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />
    )
    const input = screen.getByRole('textbox', {
      name: i18n.t('popup.quickAdd.inputLabel'),
    }) as HTMLTextAreaElement

    await userEvent.type(input, 'https://example.com/file.zip')
    await userEvent.click(
      screen.getByRole('button', { name: i18n.t('popup.quickAdd.add') })
    )

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        i18n.t('popup.quickAdd.error.submitFailed')
      )
    )
    expect(input.value).toBe('https://example.com/file.zip')
    expect(screen.queryByText(/secret native path/i)).toBeNull()
  })

  it('disables all editable actions and ignores duplicate submit while pending', async () => {
    const pending = deferred<{ taskId: string }>()
    send.mockImplementation(() => pending.promise)
    const onCreated = vi.fn()
    render(
      <QuickAddTaskDialog open onOpenChange={vi.fn()} onCreated={onCreated} />
    )
    const input = screen.getByRole('textbox', {
      name: i18n.t('popup.quickAdd.inputLabel'),
    }) as HTMLTextAreaElement

    await userEvent.type(input, 'https://example.com/file.zip')
    await userEvent.dblClick(
      screen.getByRole('button', { name: i18n.t('popup.quickAdd.add') })
    )

    expect(send).toHaveBeenCalledOnce()
    expect(input.disabled).toBe(true)
    expect(
      (
        screen.getByRole('button', {
          name: i18n.t('popup.quickAdd.cancel'),
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(
      screen.getByRole('button', {
        name: i18n.t('popup.quickAdd.submitting'),
      })
    ).toBeTruthy()

    pending.resolve({ taskId: 'task-pending' })
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
  })

  it('closes with Escape and does not submit', async () => {
    const onOpenChange = vi.fn()
    render(
      <QuickAddTaskDialog
        open
        onOpenChange={onOpenChange}
        onCreated={vi.fn()}
      />
    )

    await userEvent.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('clears a failed retry draft when the user explicitly cancels', async () => {
    send.mockRejectedValue(new Error('connection dropped'))
    const onOpenChange = vi.fn()
    const first = render(
      <QuickAddTaskDialog
        open
        onOpenChange={onOpenChange}
        onCreated={vi.fn()}
      />
    )

    await userEvent.type(
      screen.getByRole('textbox', {
        name: i18n.t('popup.quickAdd.inputLabel'),
      }),
      'https://example.com/cancelled.zip'
    )
    await userEvent.click(
      screen.getByRole('button', { name: i18n.t('popup.quickAdd.add') })
    )

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(
      (await chrome.storage.session.get(QUICK_ADD_TASK_SESSION_KEY))[
        QUICK_ADD_TASK_SESSION_KEY
      ]
    ).toMatchObject({
      normalizedInput: 'https://example.com/cancelled.zip',
      idempotencyKey: expect.any(String),
    })

    await userEvent.click(
      screen.getByRole('button', { name: i18n.t('popup.quickAdd.cancel') })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(async () => {
      expect(
        (await chrome.storage.session.get(QUICK_ADD_TASK_SESSION_KEY))[
          QUICK_ADD_TASK_SESSION_KEY
        ]
      ).toBeUndefined()
    })

    first.unmount()
    render(
      <QuickAddTaskDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />
    )
    await waitFor(() =>
      expect(
        (
          screen.getByRole('textbox', {
            name: i18n.t('popup.quickAdd.inputLabel'),
          }) as HTMLTextAreaElement
        ).value
      ).toBe('')
    )
  })
})
