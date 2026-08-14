import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import type { ApplicationMenuSnapshot } from '@shared/schemas/application-menu'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  executeItem: vi.fn(),
  platform: 'win32' as NodeJS.Platform | 'web',
  refresh: vi.fn(),
  selectedTaskId: null as string | null,
  useApplicationMenu: vi.fn(),
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    get platform() {
      return mocks.platform
    },
  },
}))

vi.mock('@renderer/hooks/use-application-menu', () => ({
  useApplicationMenu: mocks.useApplicationMenu,
}))

vi.mock('@renderer/hooks/use-selected-task', () => ({
  useSelectedTask: () => ({
    task: mocks.selectedTaskId ? { id: mocks.selectedTaskId } : null,
  }),
}))

import {
  formatMenuAccelerator,
  MotrixMenuButton,
  shouldRestoreMenuFocus,
} from './motrix-menu-button'

const menuSnapshot: ApplicationMenuSnapshot = {
  revision: 7,
  items: [
    {
      id: 'app.about',
      type: 'normal',
      label: 'About Motrix',
      accelerator: 'CommandOrControl+,',
      enabled: true,
      visible: true,
    },
    {
      id: 'view.hidden',
      type: 'normal',
      label: 'Hidden command',
      enabled: true,
      visible: false,
    },
    {
      id: 'view.separator',
      type: 'separator',
      label: '',
      enabled: false,
      visible: true,
    },
    {
      id: 'view.sidebar',
      type: 'checkbox',
      label: 'Show Sidebar',
      enabled: true,
      visible: true,
      checked: true,
    },
    {
      id: 'view.mode.compact',
      type: 'radio',
      label: 'Compact',
      enabled: true,
      visible: true,
      checked: false,
      radioGroupId: 'view.mode',
    },
    {
      id: 'view.mode.comfortable',
      type: 'radio',
      label: 'Comfortable',
      enabled: true,
      visible: true,
      checked: true,
      radioGroupId: 'view.mode',
    },
    {
      id: 'task',
      type: 'submenu',
      label: 'Task',
      enabled: true,
      visible: true,
      children: [
        {
          id: 'task.pause',
          type: 'normal',
          label: 'Pause Task',
          enabled: true,
          visible: true,
        },
      ],
    },
  ],
}

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = () => false
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

describe('MotrixMenuButton', () => {
  beforeEach(() => {
    mocks.platform = 'win32'
    mocks.selectedTaskId = null
    mocks.executeItem.mockReset().mockResolvedValue(undefined)
    mocks.refresh.mockReset().mockResolvedValue(undefined)
    mocks.useApplicationMenu.mockReset().mockReturnValue({
      snapshot: menuSnapshot,
      refresh: mocks.refresh,
      executeItem: mocks.executeItem,
    })
  })

  it('gates before mounting its hook outside Windows and Linux', () => {
    mocks.platform = 'darwin'
    const { container } = render(<MotrixMenuButton />)
    expect(container).toBeEmptyDOMElement()
    expect(mocks.useApplicationMenu).not.toHaveBeenCalled()
  })

  it('renders a fixed-width no-drag trigger and refreshes when opened', async () => {
    const user = userEvent.setup()
    render(<MotrixMenuButton />)

    const trigger = screen.getByRole('button', { name: 'Motrix' })
    expect(trigger).toHaveAttribute('data-slot', 'motrix-menu-trigger')
    expect(trigger).toHaveClass(
      'app-no-drag',
      'h-7',
      'w-[72px]',
      'pl-2',
      'pr-1'
    )
    const logo = trigger.querySelector('[data-slot="motrix-menu-logo"]')
    expect(logo).toHaveClass('h-2.5', 'w-11', 'bg-foreground')
    expect(logo).toHaveStyle({ maskImage: 'url("./mo-logo.svg")' })

    await user.click(trigger)
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1))
    expect(
      await screen.findByRole('menuitem', { name: /About Motrix/ })
    ).toBeInTheDocument()
    expect(screen.getByText('Ctrl+,')).toBeInTheDocument()
  })

  it('renders visibility, checkbox, radio, separator, and submenu state', async () => {
    const user = userEvent.setup()
    const { container } = render(<MotrixMenuButton />)
    await user.click(screen.getByRole('button', { name: 'Motrix' }))

    const checkbox = await screen.findByRole('menuitemcheckbox', {
      name: 'Show Sidebar',
    })
    expect(screen.queryByText('Hidden command')).toBeNull()
    expect(checkbox).toHaveAttribute('aria-checked', 'true')
    expect(
      screen.getByRole('menuitemradio', { name: 'Comfortable' })
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      container.ownerDocument.querySelectorAll(
        '[data-slot="dropdown-menu-separator"]'
      )
    ).toHaveLength(1)

    await user.hover(screen.getByRole('menuitem', { name: 'Task' }))
    expect(
      await screen.findByRole('menuitem', { name: 'Pause Task' })
    ).toBeInTheDocument()
  })

  it('executes checkbox and radio items with the rendered revision', async () => {
    const user = userEvent.setup()
    render(<MotrixMenuButton />)

    await user.click(screen.getByRole('button', { name: 'Motrix' }))
    await user.click(
      await screen.findByRole('menuitemcheckbox', { name: 'Show Sidebar' })
    )
    await waitFor(() => expect(mocks.executeItem).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: 'Motrix' }))
    await user.click(
      await screen.findByRole('menuitemradio', { name: 'Compact' })
    )
    await waitFor(() => expect(mocks.executeItem).toHaveBeenCalledTimes(2))

    expect(mocks.executeItem.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ itemId: 'view.sidebar', revision: 7 }),
      expect.objectContaining({ itemId: 'view.mode.compact', revision: 7 }),
    ])
  })

  it('restores the pre-open focus before executing with click modifiers', async () => {
    let focusWhenExecuted: Element | null = null
    mocks.executeItem.mockImplementation(async () => {
      focusWhenExecuted = document.activeElement
    })
    const { container } = render(
      <>
        <input aria-label="Source input" />
        <MotrixMenuButton />
      </>
    )
    const sourceInput = screen.getByRole('textbox', { name: 'Source input' })
    sourceInput.focus()

    const trigger = screen.getByRole('button', { name: 'Motrix' })
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    const item = await screen.findByRole('menuitem', { name: /About Motrix/ })
    fireEvent.click(item, { altKey: true, ctrlKey: true, shiftKey: true })

    await waitFor(() => expect(mocks.executeItem).toHaveBeenCalledTimes(1))
    expect(focusWhenExecuted).toBe(sourceInput)
    await waitFor(() => expect(sourceInput).toHaveFocus())
    expect(mocks.executeItem).toHaveBeenCalledWith({
      itemId: 'app.about',
      revision: 7,
      trigger: 'menu',
      selectedTaskId: null,
      modifiers: { alt: true, control: true, meta: false, shift: true },
    })
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('returns keyboard focus to the trigger after Escape closes the menu', async () => {
    const user = userEvent.setup()
    render(<MotrixMenuButton />)

    const trigger = screen.getByRole('button', { name: 'Motrix' })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull(), {
      timeout: 3_000,
    })
    expect(trigger).toHaveFocus()
    expect(mocks.executeItem).not.toHaveBeenCalled()
  })

  it('restores focus only for selection and Escape close reasons', () => {
    expect(shouldRestoreMenuFocus('item-press')).toBe(true)
    expect(shouldRestoreMenuFocus('escape-key')).toBe(true)
    expect(shouldRestoreMenuFocus('outside-press')).toBe(false)
  })
})

describe('formatMenuAccelerator', () => {
  it('formats Electron CommandOrControl accelerators for Windows/Linux', () => {
    expect(formatMenuAccelerator('CommandOrControl+Shift+N')).toBe(
      'Ctrl+Shift+N'
    )
    expect(formatMenuAccelerator('CmdOrCtrl+Option+Return')).toBe(
      'Ctrl+Alt+Enter'
    )
  })
})
