import {
  generalSettingsSnapshot,
  TEST_GENERAL_REVISION,
} from '@test-utils/general-settings'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { transport } from '@renderer/lib/transport'
import {
  type PlatformServices,
  PlatformServicesProvider,
} from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryPreferencesDialog } from './directory-preferences-dialog'

vi.mock('@renderer/lib/transport', () => ({ transport: { invoke: vi.fn() } }))
const initial = {
  favorites: ['/downloads/Movies ', '/missing'],
  recent: ['/downloads/Music', '/stale/recent'],
}
const ok = (value = initial) => ({
  ok: true,
  value: generalSettingsSnapshot(value),
})
function platform(
  pickSaveDir: PlatformServices['pickSaveDir'] = vi
    .fn()
    .mockResolvedValue(null),
  kind: PlatformServices['kind'] = 'electron'
): PlatformServices {
  return {
    kind,
    pickSaveDir,
    closeHost: vi.fn(),
    readClipboard: vi.fn(),
    openExternal: vi.fn(),
    notify: vi.fn(),
  }
}
function Harness({
  services = platform(),
  close = vi.fn(),
}: {
  services?: PlatformServices
  close?: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <PlatformServicesProvider services={services}>
      <button type="button" onClick={() => setOpen(true)}>
        Manage directories
      </button>
      <DirectoryPreferencesDialog
        open={open}
        onClose={() => {
          close()
          setOpen(false)
        }}
      />
    </PlatformServicesProvider>
  )
}
async function openManager(services = platform(), close = vi.fn()) {
  const rendered = render(<Harness services={services} close={close} />)
  const trigger = screen.getByRole('button', { name: 'Manage directories' })
  trigger.focus()
  fireEvent.click(trigger)
  const manager = screen.getByRole('dialog', { name: 'Manage directories' })
  await waitFor(() =>
    expect(within(manager).getByRole('button', { name: 'Save' })).toBeEnabled()
  )
  return { ...rendered, trigger, manager, close }
}
const saves = () =>
  vi
    .mocked(transport.invoke)
    .mock.calls.filter(([channel]) => channel === Commands.SaveGeneralSettings)
beforeEach(() => {
  vi.mocked(transport.invoke).mockReset().mockResolvedValue(ok())
})
afterEach(cleanup)

describe('DirectoryPreferencesDialog draft', () => {
  it.each(['electron', 'web'] as const)(
    'adds a favorite with %s Browse and persists only on Save',
    async (kind) => {
      const pick = vi.fn().mockResolvedValue('/chosen ')
      const { close } = await openManager(platform(pick, kind))
      fireEvent.click(screen.getByRole('button', { name: 'Add favorite' }))
      await screen.findByTitle('/chosen ', { normalizer: (value) => value })
      expect(pick).toHaveBeenCalledWith(undefined, {
        allowFavoriteEditing: false,
      })
      expect(saves()).toEqual([])
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
      expect(saves()[0]?.[1]).toEqual({
        expectedRevision: TEST_GENERAL_REVISION,
        app: {},
        directories: {
          addFavorites: ['/chosen '],
          removeFavorites: [],
          removeRecent: [],
        },
      })
      expect(
        vi
          .mocked(transport.invoke)
          .mock.calls.some(
            ([channel]) => channel === Commands.MutateDirectoryPreferences
          )
      ).toBe(false)
    }
  )

  it('centers focus before draft removal and Cancel discards exact raw-path changes', async () => {
    const { trigger } = await openManager()
    const remove = screen.getByRole('button', {
      name: 'Remove favorite /downloads/Movies',
    })
    remove.focus()
    fireEvent.click(remove)
    expect(screen.getByTestId('directory-preferences-section')).toHaveFocus()
    expect(
      screen.queryByTitle('/downloads/Movies ', {
        normalizer: (value) => value,
      })
    ).toBeNull()
    expect(saves()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(trigger).toHaveFocus())
    fireEvent.click(trigger)
    expect(
      await screen.findByTitle('/downloads/Movies ', {
        normalizer: (value) => value,
      })
    ).toBeInTheDocument()
  })

  it('collapses recent folders by default and stages promotion, per-row removal and clear as deltas', async () => {
    await openManager()
    expect(
      screen.queryByRole('button', {
        name: 'Remove recent folder /stale/recent',
      })
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Recent folders/ }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Add to favorites /downloads/Music' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove recent folder /stale/recent' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear recent folders' })
    )
    expect(saves()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect(saves()[0]?.[1]).toEqual({
      expectedRevision: TEST_GENERAL_REVISION,
      app: {},
      directories: {
        addFavorites: ['/downloads/Music'],
        removeFavorites: [],
        removeRecent: ['/downloads/Music', '/stale/recent'],
      },
    })
  })

  it('retains a failed draft, reloads without losing edits, and saves only identities from its baseline', async () => {
    const { close } = await openManager()
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove favorite /missing' })
    )
    vi.mocked(transport.invoke).mockResolvedValueOnce({
      ok: false,
      error: { code: 'permissionDenied' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    expect(close).not.toHaveBeenCalled()
    expect(screen.queryByTitle('/missing')).toBeNull()
    vi.mocked(transport.invoke).mockResolvedValueOnce(
      ok({ ...initial, favorites: [...initial.favorites, '/remote-new'] })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByTitle('/remote-new')
    expect(screen.queryByTitle('/missing')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(saves()[1]?.[1]).toEqual({
      expectedRevision: TEST_GENERAL_REVISION,
      app: {},
      directories: {
        addFavorites: [],
        removeFavorites: ['/missing'],
        removeRecent: [],
      },
    })
  })

  it('contains parent shortcuts and keeps cancellation locked with stable focus during Save', async () => {
    const { close, manager } = await openManager()
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove favorite /missing' })
    )
    let release!: (value: unknown) => void
    vi.mocked(transport.invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(screen.getByTestId('directory-preferences-content')).toHaveFocus()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: 'Enter',
        ctrlKey: true,
      })
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: 'Enter',
        metaKey: true,
      })
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: 'Escape',
      })
      expect(outer).not.toHaveBeenCalled()
      expect(close).not.toHaveBeenCalled()
      expect(manager).toBeInTheDocument()
      await waitFor(() => expect(release).toBeTypeOf('function'))
      await act(async () => release(ok()))
      await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    } finally {
      window.removeEventListener('keydown', outer)
    }
  })

  it('rejects invalid initial results and cannot save an empty substitute baseline', async () => {
    vi.mocked(transport.invoke).mockResolvedValueOnce({
      ok: true,
      value: { favorites: [], recent: [], unexpected: true },
    })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage directories' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByTitle('/missing')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(saves()).toEqual([])
  })

  it('cancels a real nested picker without altering the draft and restores Add favorite focus', async () => {
    function NestedHarness() {
      const [pickOpen, setPickOpen] = useState(false)
      const [resolver, setResolver] = useState<
        ((value: string | null) => void) | null
      >(null)
      const pickSaveDir = () =>
        new Promise<string | null>((resolve) => {
          setResolver(() => resolve)
          setPickOpen(true)
        })
      return (
        <>
          <Harness services={platform(pickSaveDir)} />
          <Dialog
            open={pickOpen}
            onOpenChange={(open) => {
              if (!open) {
                setPickOpen(false)
                resolver?.(null)
              }
            }}
          >
            <DialogContent>
              <DialogTitle>Choose a folder</DialogTitle>
            </DialogContent>
          </Dialog>
        </>
      )
    }
    render(<NestedHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage directories' }))
    const add = await screen.findByRole('button', { name: 'Add favorite' })
    await waitFor(() => expect(add).toBeEnabled())
    add.focus()
    fireEvent.click(add)
    const picker = screen.getByRole('dialog', { name: 'Choose a folder' })
    fireEvent.keyDown(picker, { key: 'Escape' })
    await waitFor(() => expect(add).toHaveFocus())
    expect(
      screen.getByRole('dialog', { name: 'Manage directories' })
    ).toBeInTheDocument()
    expect(saves()).toEqual([])
  })

  it('ignores a native picker result after its manager is unmounted', async () => {
    let release!: (path: string | null) => void
    const { unmount } = await openManager(
      platform(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add favorite' }))
    unmount()
    await act(async () => release('/late'))
    expect(saves()).toEqual([])
    expect(vi.mocked(transport.invoke).mock.calls).toHaveLength(1)
  })
})
