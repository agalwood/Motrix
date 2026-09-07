import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  type PlatformServices,
  PlatformServicesProvider,
} from '@renderer/platform/services'
import type {
  DirectoryPreferences,
  DirectoryPreferencesErrorCode,
} from '@shared/schemas/directory-preferences'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { useState, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryPreferencesDialog } from './directory-preferences-dialog'

const shared = vi.hoisted(() => ({
  state: {
    preferences: { favorites: [], recent: [] } as DirectoryPreferences,
    loading: false,
    error: null as DirectoryPreferencesErrorCode | null,
  },
  listeners: new Set<() => void>(),
  mutate: vi.fn(),
  refresh: vi.fn(),
  subscribe(listener: () => void) {
    shared.listeners.add(listener)
    return () => {
      shared.listeners.delete(listener)
    }
  },
  getSnapshot: () => shared.state,
}))
vi.mock('@renderer/lib/directory-preferences', () => ({
  useDirectoryPreferences: () => ({
    ...useSyncExternalStore(shared.subscribe, shared.getSnapshot),
    mutate: shared.mutate,
    refresh: shared.refresh,
  }),
}))

function publish(patch: Partial<typeof shared.state>) {
  shared.state = { ...shared.state, ...patch }
  for (const listener of shared.listeners) listener()
}

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

function openManager(services = platform(), close = vi.fn()) {
  render(<Harness services={services} close={close} />)
  const trigger = screen.getByRole('button', { name: 'Manage directories' })
  trigger.focus()
  fireEvent.click(trigger)
  return {
    trigger,
    manager: screen.getByRole('dialog', { name: 'Manage directories' }),
    close,
  }
}

beforeEach(() => {
  shared.mutate.mockReset().mockResolvedValue(true)
  shared.refresh.mockReset().mockResolvedValue(undefined)
  shared.state = {
    preferences: {
      favorites: ['/downloads/Movies ', '/missing'],
      recent: ['/downloads/Music', '/stale/recent'],
    },
    loading: false,
    error: null,
  }
})
afterEach(() => {
  cleanup()
  shared.listeners.clear()
})

describe('DirectoryPreferencesDialog', () => {
  it.each(['electron', 'web'] as const)(
    'uses the %s platform picker directly to add a favorite without recording recent history',
    async (kind) => {
      const pick = vi.fn().mockResolvedValue('/chosen ')
      shared.mutate.mockImplementation(async () => {
        publish({
          preferences: {
            ...shared.state.preferences,
            favorites: [...shared.state.preferences.favorites, '/chosen '],
          },
        })
        return true
      })
      openManager(platform(pick, kind))
      fireEvent.click(screen.getByRole('button', { name: 'Add favorite' }))
      await waitFor(() =>
        expect(shared.mutate).toHaveBeenCalledWith({
          action: 'addFavorite',
          path: '/chosen ',
        })
      )
      expect(pick).toHaveBeenCalledWith()
      expect(shared.mutate).toHaveBeenCalledTimes(1)
      expect(screen.getByText('/chosen', { exact: false })).toHaveTextContent(
        '/chosen'
      )
      expect(screen.getByRole('button', { name: 'Add favorite' })).toHaveFocus()
    }
  )

  it('removes one exact raw favorite record after moving focus to a stable element', async () => {
    let complete: ((value: boolean) => void) | undefined
    shared.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    openManager()
    const remove = screen.getByRole('button', {
      name: 'Remove favorite /downloads/Movies',
    })
    remove.focus()
    fireEvent.click(remove)
    expect(shared.mutate).toHaveBeenCalledWith({
      action: 'removeFavorite',
      paths: ['/downloads/Movies '],
    })
    expect(screen.getByTestId('directory-preferences-content')).toHaveFocus()
    expect(remove).toBeDisabled()
    expect(
      screen.getByText('/downloads/Movies', { exact: false })
    ).toBeInTheDocument()
    fireEvent.click(remove)
    expect(shared.mutate).toHaveBeenCalledTimes(1)
    await act(async () => {
      publish({
        preferences: { ...shared.state.preferences, favorites: ['/missing'] },
      })
      complete?.(true)
    })
    expect(
      screen.queryByRole('button', {
        name: 'Remove favorite /downloads/Movies',
      })
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('directory-preferences-content')).toHaveFocus()
  })

  it('promotes a recent, deletes a single stale recent, and clears recent records with dedicated actions', async () => {
    openManager()
    fireEvent.click(
      screen.getByRole('button', { name: 'Add to favorites /downloads/Music' })
    )
    await waitFor(() =>
      expect(shared.mutate).toHaveBeenCalledWith({
        action: 'addFavorite',
        path: '/downloads/Music',
      })
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Remove recent folder /stale/recent',
        })
      ).toBeEnabled()
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove recent folder /stale/recent' })
    )
    await waitFor(() =>
      expect(shared.mutate).toHaveBeenCalledWith({
        action: 'removeRecent',
        paths: ['/stale/recent'],
      })
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Clear recent folders' })
      ).toBeEnabled()
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear recent folders' })
    )
    await waitFor(() =>
      expect(shared.mutate).toHaveBeenCalledWith({ action: 'clearRecent' })
    )
    expect(shared.mutate).toHaveBeenCalledTimes(3)
  })

  it('keeps old records on failure and retries an authoritative read without replaying the mutation', async () => {
    shared.mutate.mockImplementation(async () => {
      publish({ error: 'permissionDenied' })
      return false
    })
    openManager()
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove favorite /missing' })
    )
    await screen.findByRole('alert')
    expect(
      screen.getByRole('button', { name: 'Remove favorite /missing' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(shared.refresh).toHaveBeenCalledTimes(1)
    expect(shared.mutate).toHaveBeenCalledTimes(1)
  })

  it('keeps cancellation and keyboard isolation safe while a mutation is pending', async () => {
    let complete: ((value: boolean) => void) | undefined
    shared.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const parentShortcut = vi.fn()
    window.addEventListener('keydown', parentShortcut)
    const { manager, trigger, close } = openManager()
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove favorite /missing' })
    )
    const content = screen.getByTestId('directory-preferences-content')
    fireEvent.keyDown(content, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(content, { key: 'Enter', metaKey: true })
    expect(parentShortcut).not.toHaveBeenCalled()
    expect(within(manager).getByRole('button', { name: 'Close' })).toBeEnabled()
    fireEvent.keyDown(content, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(trigger).toHaveFocus())
    await act(async () => {
      complete?.(true)
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    window.removeEventListener('keydown', parentShortcut)
  })

  it('cancels a nested picker without adding a favorite, keeps the manager open, and restores Add favorite focus', async () => {
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
            <DialogContent
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setPickOpen(false)
                  resolver?.(null)
                }
              }}
            >
              <DialogTitle>Nested picker</DialogTitle>
              <button
                type="button"
                onClick={() => {
                  setPickOpen(false)
                  resolver?.(null)
                }}
              >
                Cancel picker
              </button>
            </DialogContent>
          </Dialog>
        </>
      )
    }
    render(<NestedHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage directories' }))
    const add = screen.getByRole('button', { name: 'Add favorite' })
    add.focus()
    fireEvent.click(add)
    const nested = await screen.findByRole('dialog', { name: 'Nested picker' })
    fireEvent.keyDown(
      within(nested).getByRole('button', { name: 'Cancel picker' }),
      { key: 'Escape' }
    )
    await waitFor(() => expect(add).toBeEnabled())
    expect(
      screen.getByRole('dialog', { name: 'Manage directories' })
    ).toBeInTheDocument()
    expect(shared.mutate).not.toHaveBeenCalled()
    await waitFor(() => expect(add).toHaveFocus())
  })

  it('disables additions at the favorites limit while retaining all records for deletion', () => {
    shared.state.preferences.favorites = Array.from(
      { length: 20 },
      (_, index) => `/favorite-${index}`
    )
    openManager()
    expect(screen.getByRole('button', { name: 'Add favorite' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Add to favorites /downloads/Music' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Remove favorite /favorite-19' })
    ).toBeEnabled()
    expect(
      screen.getByText('You can save up to 20 favorite folders.')
    ).toBeInTheDocument()
  })

  it('keeps focus inside the manager when another client removes the focused record', async () => {
    openManager()
    const remove = screen.getByRole('button', {
      name: 'Remove favorite /missing',
    })
    remove.focus()
    act(() =>
      publish({
        preferences: {
          ...shared.state.preferences,
          favorites: ['/downloads/Movies '],
        },
      })
    )
    expect(screen.getByTestId('directory-preferences-content')).toHaveFocus()
    expect(shared.mutate).not.toHaveBeenCalled()
  })
})
