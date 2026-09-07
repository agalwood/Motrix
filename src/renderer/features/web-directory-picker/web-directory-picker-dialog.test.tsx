import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { directoryPreferences } from '@renderer/lib/directory-preferences'
import { transport } from '@renderer/lib/transport'
import { __webPathPickerBus } from '@renderer/platform/web-services'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  forwardRef,
  StrictMode,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebDirectoryPickerDialog } from './web-directory-picker-dialog'

vi.mock('@renderer/lib/transport', () => ({
  transport: { platform: 'linux', invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))
// Component tests isolate virtualization geometry; the browser harness exercises the real VirtualList.
vi.mock('@renderer/components/desktop-kit/virtual-list/virtual-list', () => ({
  VirtualList: forwardRef((props: Record<string, unknown>, ref) => {
    const node = useRef<HTMLDivElement>(null)
    useImperativeHandle(ref, () => ({
      scrollToOffset() {},
      scrollToIndex() {},
      getScrollOffset: () => 0,
      getContainerRef: () => node.current,
    }))
    const { items, renderRow, renderEmpty, containerProps, scrollRef } =
      props as {
        items: { path: string }[]
        renderRow: (row: Record<string, unknown>) => React.ReactNode
        renderEmpty: () => React.ReactNode
        containerProps: React.HTMLAttributes<HTMLDivElement>
        scrollRef: React.RefObject<HTMLDivElement | null>
      }
    return (
      <div
        {...containerProps}
        ref={(element) => {
          node.current = element
          scrollRef.current = element
        }}
      >
        {items.length
          ? items.map((item, index) => (
              <div key={item.path}>{renderRow({ item, index, style: {} })}</div>
            ))
          : renderEmpty()}
      </div>
    )
  }),
}))

const directories = (path = '/downloads', names = ['Alpha', 'Beta']) => ({
  ok: true,
  value: {
    path,
    parentPath: path === '/downloads' ? null : '/downloads',
    breadcrumbs: [
      { name: 'downloads', path: '/downloads' },
      ...(path === '/downloads'
        ? []
        : [{ name: path.split('/').at(-1) || '/', path }]),
    ],
    entries: names.map((name) => ({ name, path: `${path}/${name}` })),
    truncated: false,
    canCreate: true,
  },
})

function Harness({ strict = false }: { strict?: boolean }) {
  const [pending, setPending] = useState(false)
  const [value, setValue] = useState('/downloads')
  const tree = (
    <>
      <Dialog open>
        <DialogContent>
          <DialogTitle>Parent</DialogTitle>
          <button
            type="button"
            disabled={pending}
            onClick={async () => {
              setPending(true)
              const path = await __webPathPickerBus.request({
                defaultPath: value,
              })
              if (path) setValue(path)
              setPending(false)
            }}
          >
            Browse
          </button>
          <output data-testid="value">{value}</output>
        </DialogContent>
      </Dialog>
      <WebDirectoryPickerDialog />
    </>
  )
  return strict ? <StrictMode>{tree}</StrictMode> : tree
}

async function openPicker() {
  const opener = screen.getByRole('button', { name: 'Browse' })
  opener.focus()
  fireEvent.click(opener)
  await screen.findByRole('option', { name: 'Alpha' })
  return { opener, list: screen.getByRole('listbox', { name: 'Folders' }) }
}

beforeEach(() => {
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    value: 'Win32',
  })
  vi.mocked(transport.invoke).mockImplementation(async (channel, payload) => {
    if (channel === Queries.ListServerDirectoryLocations)
      return { ok: true, value: { common: [], favorites: [], recent: [] } }
    if (channel === Queries.ListAllowedSaveDirs)
      return {
        paths: [{ path: '/downloads' }],
        defaultPath: '/downloads',
        allowCustom: false,
      }
    if (channel === Queries.ListServerDirectories)
      return directories((payload as { path: string }).path)
    if (channel === Queries.ValidateServerDirectory)
      return { ok: true, value: payload }
    if (channel === Commands.CreateServerDirectory)
      return { ok: false, error: { code: 'alreadyExists' } }
    throw new Error('Unexpected channel')
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('WebDirectoryPickerDialog', () => {
  it('groups native common places and saved paths, deduplicates roots, and retains semantic shortcuts', async () => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    })
    const original = vi.mocked(transport.invoke).getMockImplementation()!
    vi.mocked(transport.invoke).mockImplementation((channel, ...args) =>
      channel === Queries.ListServerDirectoryLocations
        ? Promise.resolve({
            ok: true,
            value: {
              common: [
                { kind: 'default', path: '/downloads' },
                { kind: 'home', path: '/downloads' },
                { kind: 'desktop', path: '/desktop' },
                { kind: 'documents', path: '/documents' },
              ],
              favorites: [
                {
                  name: 'Favorite',
                  path: '/favorite',
                  sourcePaths: ['/favorite'],
                },
              ],
              recent: [
                { name: 'Recent', path: '/recent', sourcePaths: ['/recent'] },
              ],
            },
          })
        : original(channel, ...args)
    )
    render(<Harness />)
    const { list } = await openPicker()
    const sidebar = screen.getByTestId('directory-picker-locations')
    expect(within(sidebar).getByText('Common places')).toBeInTheDocument()
    expect(
      within(sidebar).getByRole('button', { name: 'Favorite' })
    ).toBeInTheDocument()
    expect(
      within(sidebar).getByRole('button', { name: 'Recent' })
    ).toBeInTheDocument()
    expect(
      within(sidebar)
        .getAllByRole('button')
        .filter((button) => button.title === '/downloads')
    ).toHaveLength(1)
    expect(
      within(sidebar).queryByText('Allowed locations')
    ).not.toBeInTheDocument()
    expect(
      within(sidebar).queryByRole('button', { name: 'Home' })
    ).not.toBeInTheDocument()
    const select = screen.getByRole('combobox', { name: 'Location' })
    expect(select.querySelectorAll('optgroup')).toHaveLength(3)

    fireEvent.keyDown(list, {
      key: 'D',
      metaKey: true,
      shiftKey: true,
      ctrlKey: true,
    })
    expect(screen.getByTestId('directory-picker-target')).toHaveTextContent(
      '/downloads'
    )
    fireEvent.keyDown(list, { key: 'D', metaKey: true, shiftKey: true })
    await waitFor(() =>
      expect(screen.getByTestId('directory-picker-target')).toHaveTextContent(
        '/desktop'
      )
    )
    fireEvent.keyDown(list, { key: 'H', metaKey: true, shiftKey: true })
    await waitFor(() =>
      expect(screen.getByTestId('directory-picker-target')).toHaveTextContent(
        '/downloads'
      )
    )
    fireEvent.keyDown(list, { key: 'O', metaKey: true, shiftKey: true })
    await waitFor(() =>
      expect(screen.getByTestId('directory-picker-target')).toHaveTextContent(
        '/documents'
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Go to folder' }))
    const editor = screen.getByRole('textbox', { name: 'Folder path' })
    fireEvent.keyDown(editor, { key: 'H', metaKey: true, shiftKey: true })
    expect(editor).toHaveValue('/documents')
  })

  it('moves focus to the list before a favorite mutation disables its trigger', async () => {
    let complete!: (value: boolean) => void
    vi.spyOn(directoryPreferences, 'mutate').mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    render(<Harness />)
    const { list } = await openPicker()
    const star = screen.getByTestId('directory-picker-favorite')
    star.focus()
    fireEvent.click(star)
    expect(star).toBeDisabled()
    expect(list).toHaveFocus()
    const escaped = vi.fn()
    document.addEventListener('keydown', escaped)
    fireEvent.keyDown(document.activeElement!, { key: 'Enter', ctrlKey: true })
    document.removeEventListener('keydown', escaped)
    expect(escaped).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Select folder' })).toBeEnabled()
    await act(async () => complete(true))
  })

  it('restores a stable focus target when an event removes the focused saved location', async () => {
    const original = vi.mocked(transport.invoke).getMockImplementation()!
    let saved = true
    vi.mocked(transport.invoke).mockImplementation((channel, ...args) =>
      channel === Queries.ListServerDirectoryLocations
        ? Promise.resolve({
            ok: true,
            value: {
              common: [],
              recent: [],
              favorites: saved
                ? [
                    {
                      name: 'Favorite',
                      path: '/favorite',
                      sourcePaths: ['/favorite'],
                    },
                  ]
                : [],
            },
          })
        : original(channel, ...args)
    )
    render(<Harness />)
    const { list } = await openPicker()
    const favorite = screen.getByRole('button', { name: 'Favorite' })
    favorite.focus()
    saved = false
    act(() => {
      for (const [channel, listener] of vi.mocked(transport.on).mock.calls)
        if (channel === Events.DirectoryPreferencesChanged)
          listener({ favorites: [], recent: [] })
    })
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Favorite' })
      ).not.toBeInTheDocument()
    )
    expect(list).toHaveFocus()
  })

  it.each(['location select', 'favorite star'])(
    'contains parent submit shortcuts when an event invalidates the focused %s',
    async (control) => {
      const original = vi.mocked(transport.invoke).getMockImplementation()!
      let refresh = false
      let complete!: (value: unknown) => void
      vi.mocked(transport.invoke).mockImplementation((channel, ...args) => {
        if (channel === Queries.ListAllowedSaveDirs)
          return Promise.resolve({
            paths: [],
            defaultPath: '/downloads',
            allowCustom: true,
          })
        if (channel === Queries.ListServerDirectoryLocations)
          return refresh
            ? new Promise((resolve) => {
                complete = resolve
              })
            : Promise.resolve({
                ok: true,
                value: {
                  common: [{ kind: 'home', path: '/downloads' }],
                  favorites: [],
                  recent: [],
                },
              })
        return original(channel, ...args)
      })
      render(<Harness />)
      const { list } = await openPicker()
      const focused =
        control === 'location select'
          ? screen.getByRole('combobox', { name: 'Location' })
          : screen.getByTestId('directory-picker-favorite')
      focused.focus()
      refresh = true
      act(() => {
        for (const [channel, listener] of vi.mocked(transport.on).mock.calls)
          if (channel === Events.DirectoryPreferencesChanged)
            listener({ favorites: [], recent: [] })
      })
      expect(list).toHaveFocus()
      if (control === 'location select') expect(focused).not.toBeInTheDocument()
      else expect(focused).toBeDisabled()
      const escaped = vi.fn()
      document.addEventListener('keydown', escaped)
      fireEvent.keyDown(document.activeElement!, {
        key: 'Enter',
        ctrlKey: true,
      })
      document.removeEventListener('keydown', escaped)
      expect(escaped).not.toHaveBeenCalled()
      await waitFor(() => expect(complete).toBeDefined())
      await act(async () =>
        complete({ ok: true, value: { common: [], favorites: [], recent: [] } })
      )
    }
  )

  it('loads inside StrictMode without automatically selecting a child and restores the enabled opener', async () => {
    render(<Harness strict />)
    const { opener, list } = await openPicker()
    expect(list).toHaveFocus()
    expect(screen.getByTestId('directory-picker-target')).toHaveTextContent(
      '/downloads'
    )
    expect(
      within(list)
        .getAllByRole('option')
        .every((option) => option.getAttribute('aria-selected') === 'false')
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    await waitFor(() =>
      expect(
        screen.queryByTestId('web-directory-picker')
      ).not.toBeInTheDocument()
    )
    await waitFor(() => expect(opener).toHaveFocus())
    expect(opener).toBeEnabled()
    expect(screen.getByRole('dialog', { name: 'Parent' })).toBeInTheDocument()
  })

  it('single clicks select and double clicks enter, with Up reselecting the departed folder', async () => {
    render(<Harness />)
    await openPicker()
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }))
    expect(screen.getByTestId('directory-picker-target')).toHaveTextContent(
      '/downloads/Beta'
    )
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(
          ([channel]) => channel === Queries.ListServerDirectories
        )
    ).toHaveLength(1)
    fireEvent.doubleClick(screen.getByRole('option', { name: 'Beta' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Up one level' })).toBeEnabled()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Up one level' }))
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Beta' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    )
    expect(screen.getByRole('button', { name: 'Up one level' })).toBeDisabled()
  })

  it('contains parent shortcuts and IME, and cancels the name editor before the modal', async () => {
    render(<Harness />)
    const { list } = await openPicker()
    const parentShortcut = vi.fn()
    document.addEventListener('keydown', parentShortcut)
    window.addEventListener('keydown', parentShortcut)
    fireEvent.keyDown(list, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(list, { key: 'Enter', isComposing: true })
    expect(parentShortcut).not.toHaveBeenCalled()
    expect(screen.getByTestId('web-directory-picker')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    const input = screen.getByRole('textbox', { name: 'Folder name' })
    fireEvent.change(input, { target: { value: 'Existing' } })
    expect(screen.getByRole('button', { name: 'Select folder' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByRole('alert')
    expect(input).toHaveValue('Existing')
    expect(
      fireEvent.keyDown(screen.getByRole('button', { name: 'Create' }), {
        key: 'Enter',
        repeat: true,
      })
    ).toBe(false)
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(
          ([channel]) => channel === Commands.CreateServerDirectory
        )
    ).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(
      screen.queryByRole('textbox', { name: 'Folder name' })
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('web-directory-picker')).toBeInTheDocument()
    fireEvent.keyDown(list, { key: 'Escape' })
    await waitFor(() =>
      expect(
        screen.queryByTestId('web-directory-picker')
      ).not.toBeInTheDocument()
    )
    expect(screen.getByRole('dialog', { name: 'Parent' })).toBeInTheDocument()
    document.removeEventListener('keydown', parentShortcut)
    window.removeEventListener('keydown', parentShortcut)
  })

  it('uses client Mac Return to confirm although the server reports Linux', async () => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    })
    render(<Harness />)
    const { list } = await openPicker()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    fireEvent.keyDown(list, { key: 'Enter' })
    await waitFor(() =>
      expect(screen.getByTestId('value')).toHaveTextContent('/downloads/Alpha')
    )
  })

  it('starts fresh typeahead immediately after entering a different folder', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
    try {
      render(<Harness />)
      const { list } = await openPicker()
      fireEvent.keyDown(list, { key: 'a' })
      fireEvent.keyDown(list, { key: 'l' })
      fireEvent.keyDown(list, { key: 'Enter' })
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Up one level' })
        ).toBeEnabled()
      )
      fireEvent.keyDown(list, { key: 'b' })
      expect(screen.getByRole('option', { name: 'Beta' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      expect(screen.getByTestId('directory-picker-target')).toHaveTextContent(
        '/downloads/Alpha/Beta'
      )
    } finally {
      clock.mockRestore()
    }
  })

  it('does not let a superseded session restore focus behind the replacement', async () => {
    render(<Harness />)
    const { opener } = await openPicker()
    let replacement: Promise<string | null> | undefined
    act(() => {
      replacement = __webPathPickerBus.request({
        defaultPath: '/downloads/Beta',
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('directory-picker-target')).toHaveTextContent(
        '/downloads/Beta'
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(opener).not.toHaveFocus()
    expect(screen.getByRole('listbox', { name: 'Folders' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    await expect(replacement).resolves.toBeNull()
  })

  it('freezes pointer and keyboard targets during validation and ignores its result after cancellation', async () => {
    const original = vi.mocked(transport.invoke).getMockImplementation()
    let complete: ((value: unknown) => void) | undefined
    vi.mocked(transport.invoke).mockImplementation((channel, ...args) =>
      channel === Queries.ValidateServerDirectory
        ? new Promise((resolve) => {
            complete = resolve
          })
        : original!(channel, ...args)
    )
    render(<Harness />)
    const { list } = await openPicker()
    fireEvent.click(screen.getByRole('option', { name: 'Alpha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    await waitFor(() => expect(complete).toBeDefined())
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }))
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(screen.getByTestId('directory-picker-target')).toHaveTextContent(
      '/downloads/Alpha'
    )
    for (const name of [
      'Select folder',
      'New folder',
      'Go to folder',
      'Refresh',
    ])
      expect(screen.getByRole('button', { name })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => {
      complete?.({ ok: true, value: { path: '/downloads/Alpha' } })
    })
    expect(screen.queryByTestId('web-directory-picker')).not.toBeInTheDocument()
    expect(screen.getByTestId('value')).toHaveTextContent('/downloads')
  })

  it('settles a pending request if its host and parent unmount, without late focus restoration', async () => {
    let pending: Promise<string | null> | undefined
    const original = vi.mocked(transport.invoke).getMockImplementation()
    let complete: ((value: unknown) => void) | undefined
    vi.mocked(transport.invoke).mockImplementation((channel, ...args) =>
      channel === Queries.ListServerDirectories
        ? new Promise((resolve) => {
            complete = resolve
          })
        : original!(channel, ...args)
    )
    const outside = document.createElement('button')
    document.body.append(outside)
    const view = render(<WebDirectoryPickerDialog />)
    outside.focus()
    act(() => {
      pending = __webPathPickerBus.request({ defaultPath: '/downloads' })
    })
    await waitFor(() => expect(complete).toBeDefined())
    view.unmount()
    outside.remove()
    await expect(pending).resolves.toBeNull()
    await act(async () => {
      complete?.(directories())
    })
    expect(screen.queryByTestId('web-directory-picker')).not.toBeInTheDocument()
  })
})
