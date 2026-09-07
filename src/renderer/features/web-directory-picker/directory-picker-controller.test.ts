import type { DirectoryPreferencesStore } from '@renderer/lib/directory-preferences'
import type { Transport } from '@renderer/lib/transport/types'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DIRECTORY_OPERATION_TIMEOUT,
  type DirectoryListing,
  DirectoryPickerController,
} from './directory-picker-controller'
import { DirectorySortPreferences } from './directory-sort'

function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function listing(
  path = '/downloads',
  children = ['Movies', 'Music'],
  parentPath: string | null = null
): DirectoryListing {
  return {
    path,
    parentPath,
    breadcrumbs: [{ name: 'Downloads', path }],
    entries: children.map((name) => ({ name, path: `${path}/${name}` })),
    truncated: false,
    canCreate: true,
  }
}

const success = (value: unknown) => ({ ok: true, value })
const failure = (code: string) => ({ ok: false, error: { code } })
const flush = () => vi.advanceTimersByTimeAsync(0)
const controllers: DirectoryPickerController[] = []

function harness(defaultPath: string | undefined = '/downloads') {
  const eventListeners = new Map<string, (payload: unknown) => void>()
  const preferences = {
    mutate: vi.fn<DirectoryPreferencesStore['mutate']>(async () => true),
    getSnapshot: vi.fn<DirectoryPreferencesStore['getSnapshot']>(() => ({
      preferences: { favorites: [], recent: [] },
      loading: false,
      error: null,
    })),
  }
  const responses = new Map<string, unknown[]>()
  const invoke = vi.fn<Transport['invoke']>(async (channel, ...args) => {
    const queued = responses.get(channel)
    if (queued?.length) return queued.shift()
    if (channel === Queries.ListServerDirectoryLocations) {
      return success({ common: [], favorites: [], recent: [] })
    }
    if (channel === Queries.ListAllowedSaveDirs) {
      return {
        defaultPath: '/downloads',
        paths: [{ path: '/downloads' }, { path: '/archive' }],
        allowCustom: false,
      }
    }
    if (channel === Queries.ListServerDirectories) {
      const path = (args[0] as { path: string }).path
      if (path === '/downloads') return success(listing())
      if (path === '/downloads/Movies') {
        return success(listing(path, ['HD'], '/downloads'))
      }
      if (path === '/downloads/Music') {
        return success(listing(path, [], '/downloads'))
      }
      if (path === '/archive') return success(listing(path, []))
      return failure('notFound')
    }
    if (channel === Queries.ValidateServerDirectory) return success(args[0])
    throw new Error(`Unexpected invocation: ${channel}`)
  })
  const finish = vi.fn<(value: string | null) => void>()
  const controller = new DirectoryPickerController(
    {
      invoke,
      on: (channel, listener) => {
        eventListeners.set(channel, listener)
      },
      off: (channel, listener) => {
        if (eventListeners.get(channel) === listener)
          eventListeners.delete(channel)
      },
    },
    defaultPath,
    finish,
    preferences,
    new DirectorySortPreferences(() => ({ getItem: () => null, setItem() {} }))
  )
  controllers.push(controller)
  return {
    controller,
    invoke,
    finish,
    preferences,
    event(value: unknown) {
      eventListeners.get(Events.DirectoryPreferencesChanged)?.(value)
    },
    queue(channel: string, ...values: unknown[]) {
      responses.set(channel, [...(responses.get(channel) ?? []), ...values])
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.useRealTimers()
})

describe('DirectoryPickerController', () => {
  it('changes sorting locally, preserves selected identity and invalidates historical scroll offsets', async () => {
    const h = harness()
    await h.controller.start()
    h.controller.select('/downloads/Music')
    h.controller.setScrollOffset(800)
    h.controller.navigate('/archive')
    await flush()
    const calls = h.invoke.mock.calls.length
    const listing = h.controller.getSnapshot().listing
    h.controller.changeSort({ by: 'name', direction: 'desc' })
    expect(h.invoke).toHaveBeenCalledTimes(calls)
    expect(h.controller.getSnapshot().listing).toBe(listing)
    expect(
      h.controller.getSnapshot().history.every((entry) => entry.offset === null)
    ).toBe(true)
    h.controller.history(-1)
    await flush()
    expect(h.controller.getSnapshot()).toMatchObject({
      sort: { by: 'name', direction: 'desc' },
      selected: '/downloads/Music',
      restore: { offset: 0, reveal: '/downloads/Music' },
    })
    h.controller.changeSort({ by: 'modified', direction: 'asc' })
    expect(h.controller.getSnapshot()).toMatchObject({
      selected: '/downloads/Music',
      restore: { offset: 0, reveal: '/downloads/Music' },
    })
    const snapshot = h.controller.getSnapshot()
    h.controller.changeSort({ by: 'modified', direction: 'asc' })
    expect(h.controller.getSnapshot()).toBe(snapshot)
  })

  it('ignores delayed sorting after disposal and while editing', async () => {
    const h = harness()
    await h.controller.start()
    h.controller.editPath()
    const editing = h.controller.getSnapshot()
    h.controller.changeSort({ by: 'name', direction: 'desc' })
    expect(h.controller.getSnapshot()).toBe(editing)
    h.controller.cancelEditor()
    h.controller.dispose()
    const disposed = h.controller.getSnapshot()
    h.controller.changeSort({ by: 'name', direction: 'desc' })
    expect(h.controller.getSnapshot()).toBe(disposed)
  })
  it('keeps bootstrap roots navigable when optional locations fail', async () => {
    const h = harness()
    h.queue(Queries.ListServerDirectoryLocations, failure('unavailable'))
    await h.controller.start()
    expect(h.controller.getSnapshot().locations).toBeNull()
    h.controller.navigateLocation('/archive')
    await flush()
    expect(h.controller.getSnapshot().listing?.path).toBe('/archive')
  })
  it('keeps retained locations display-only during refresh while ordinary navigation remains available', async () => {
    const h = harness()
    const locations = {
      common: [{ kind: 'home', path: '/downloads/Movies' }],
      favorites: [],
      recent: [],
    }
    h.queue(Queries.ListServerDirectoryLocations, success(locations))
    await h.controller.start()
    const snapshot = h.controller.getSnapshot().locations
    const pending = deferred()
    h.queue(Queries.ListServerDirectoryLocations, pending.promise)
    h.event({ favorites: [], recent: [] })
    expect(h.controller.getSnapshot().locations).toBe(snapshot)
    expect(h.controller.getSnapshot().locationsLoading).toBe(true)
    const listings = () =>
      h.invoke.mock.calls.filter(
        ([channel]) => channel === Queries.ListServerDirectories
      )
    const before = listings().length
    h.controller.navigateLocation('/downloads/Movies')
    await h.controller.toggleFavorite()
    expect(listings()).toHaveLength(before)
    expect(h.preferences.mutate).not.toHaveBeenCalled()
    h.controller.navigate('/archive')
    await flush()
    expect(h.controller.getSnapshot().listing?.path).toBe('/archive')
    pending.resolve(success(locations))
    await flush()
    h.controller.navigateLocation('/downloads/Movies')
    await flush()
    expect(h.controller.getSnapshot().listing?.path).toBe('/downloads/Movies')
  })

  it('reuses the authorization query triggered by this exact committed favorite snapshot', async () => {
    const h = harness()
    await h.controller.start()
    const committed = { favorites: ['/downloads'], recent: [] }
    h.preferences.mutate.mockImplementation(async (_action, onCommitted) => {
      h.event(committed)
      await flush()
      onCommitted?.(committed)
      return true
    })
    await h.controller.toggleFavorite()
    expect(
      h.invoke.mock.calls.filter(
        ([channel]) => channel === Queries.ListServerDirectoryLocations
      )
    ).toHaveLength(2)
  })

  it('keeps browsing and confirmation independent of optional locations timeouts', async () => {
    const h = harness()
    h.queue(Queries.ListServerDirectoryLocations, new Promise(() => {}))
    await h.controller.start()
    expect(h.controller.getSnapshot()).toMatchObject({
      busy: null,
      locationsLoading: true,
      listing: { path: '/downloads' },
    })
    h.controller.navigate('/archive')
    await flush()
    await vi.advanceTimersByTimeAsync(DIRECTORY_OPERATION_TIMEOUT)
    expect(h.controller.getSnapshot()).toMatchObject({
      busy: null,
      locationsLoading: false,
      locationsError: 'unavailable',
      listing: { path: '/archive' },
    })
    h.controller.refreshLocations()
    await flush()
    expect(h.controller.getSnapshot().locationsError).toBeNull()
    await h.controller.confirm()
    expect(h.finish).toHaveBeenCalledExactlyOnceWith('/archive')
    expect(h.preferences.mutate).not.toHaveBeenCalled()
  })

  it('invalidates pending locations immediately on preference events without invalidating navigation', async () => {
    const h = harness()
    const stale = deferred()
    const fresh = deferred()
    h.queue(Queries.ListServerDirectoryLocations, stale.promise, fresh.promise)
    await h.controller.start()
    h.controller.navigate('/archive')
    h.event({ favorites: [], recent: [] })
    await flush()
    stale.resolve(
      success({
        common: [],
        favorites: [{ name: 'Old', path: '/old', sourcePaths: ['/old'] }],
        recent: [],
      })
    )
    await flush()
    expect(h.controller.getSnapshot()).toMatchObject({
      locations: null,
      locationsLoading: true,
      listing: { path: '/archive' },
    })
    fresh.resolve(success({ common: [], favorites: [], recent: [] }))
    await flush()
    expect(h.controller.getSnapshot().locations?.favorites).toEqual([])
  })

  it('favorites the browsed folder rather than its selected child and permits cancellation while pending', async () => {
    const h = harness()
    await h.controller.start()
    h.controller.select('/downloads/Movies')
    let complete!: (value: boolean) => void
    h.preferences.mutate.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve
      })
    )
    const action = h.controller.toggleFavorite()
    await h.controller.toggleFavorite()
    expect(h.preferences.mutate).toHaveBeenCalledExactlyOnceWith(
      {
        action: 'addFavorite',
        path: '/downloads',
      },
      expect.any(Function)
    )
    expect(h.controller.getSnapshot().favoriteBusy).toBe(true)
    h.controller.cancel()
    complete(true)
    await action
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(null)
    expect(
      h.invoke.mock.calls.filter(
        ([channel]) => channel === Queries.ListServerDirectoryLocations
      )
    ).toHaveLength(1)
  })

  it.each(['/downloads', '/display-alias'])(
    'removes all saved identities of a canonical group while browsing %s',
    async (path) => {
      const h = harness(path)
      const sourcePaths = ['/downloads', '/canonical/downloads']
      h.queue(Queries.ListServerDirectories, success(listing(path)))
      h.queue(
        Queries.ListServerDirectoryLocations,
        success({
          common: [],
          favorites: [
            { name: 'Downloads', path: '/display-alias', sourcePaths },
          ],
          recent: [],
        })
      )
      await h.controller.start()
      expect(h.controller.currentFavorite?.sourcePaths).toEqual(sourcePaths)
      await h.controller.toggleFavorite()
      expect(h.preferences.mutate).toHaveBeenCalledExactlyOnceWith(
        {
          action: 'removeFavorite',
          paths: sourcePaths,
        },
        expect.any(Function)
      )
    }
  )

  it('keeps a failed favorite mutation visible and excludes editor interactions', async () => {
    const h = harness()
    await h.controller.start()
    h.controller.editPath()
    await h.controller.toggleFavorite()
    expect(h.preferences.mutate).not.toHaveBeenCalled()
    h.controller.cancelEditor()
    h.preferences.mutate.mockResolvedValueOnce(false)
    h.preferences.getSnapshot.mockReturnValueOnce({
      preferences: { favorites: [], recent: [] },
      loading: false,
      error: 'limitReached',
    })
    await h.controller.toggleFavorite()
    expect(h.controller.getSnapshot()).toMatchObject({
      favoriteBusy: false,
      favoriteError: 'limitReached',
      busy: null,
    })
  })

  it('uses the initiating path and initially targets the current directory without selecting a child', async () => {
    const { controller, invoke, finish } = harness('/downloads/Movies')
    await controller.start()

    expect(invoke.mock.calls).toEqual([
      [Queries.ListServerDirectoryLocations, {}],
      [Queries.ListAllowedSaveDirs],
      [
        Queries.ListServerDirectories,
        { path: '/downloads/Movies', showHidden: false },
      ],
    ])
    expect(controller.getSnapshot()).toMatchObject({
      listing: { path: '/downloads/Movies' },
      selected: null,
      busy: null,
      notice: null,
      historyIndex: 0,
    })
    expect(controller.target).toBe('/downloads/Movies')
    await controller.confirm()
    expect(finish).toHaveBeenCalledExactlyOnceWith('/downloads/Movies')
  })

  it('explains fallback and tries the configured default before distinct allowed roots', async () => {
    const { controller, invoke, queue } = harness('/missing')
    queue(
      Queries.ListServerDirectories,
      failure('notFound'),
      failure('permissionDenied'),
      failure('notFound')
    )
    await controller.start()

    expect(invoke.mock.calls.slice(2)).toEqual([
      [Queries.ListServerDirectories, { path: '/missing', showHidden: false }],
      [
        Queries.ListServerDirectories,
        { path: '/downloads', showHidden: false },
      ],
      [Queries.ListServerDirectories, { path: '/archive', showHidden: false }],
    ])
    expect(controller.getSnapshot()).toMatchObject({
      listing: null,
      error: 'notFound',
      busy: null,
    })

    await controller.start()
    expect(controller.getSnapshot()).toMatchObject({
      listing: { path: '/downloads' },
      notice: 'fallback',
    })
  })

  it('treats only the empty string as a default sentinel and preserves literal path whitespace', async () => {
    const { controller, invoke, queue } = harness(' ')
    queue(Queries.ListServerDirectories, success(listing(' ', [])))
    await controller.start()
    expect(invoke).toHaveBeenLastCalledWith(Queries.ListServerDirectories, {
      path: ' ',
      showHidden: false,
    })
    expect(controller.target).toBe(' ')

    const empty = harness('')
    await empty.controller.start()
    expect(empty.invoke).toHaveBeenLastCalledWith(
      Queries.ListServerDirectories,
      { path: '/downloads', showHidden: false }
    )
  })

  it('rejects malformed bootstrap data and retries without accepting an arbitrary path', async () => {
    const { controller, invoke, queue } = harness('/downloads')
    queue(Queries.ListAllowedSaveDirs, {
      defaultPath: '/downloads',
      allowCustom: true,
    })
    await controller.start()
    expect(controller.getSnapshot()).toMatchObject({
      bootstrap: null,
      listing: null,
      busy: null,
      error: 'unavailable',
    })
    await controller.confirm()
    expect(invoke).toHaveBeenCalledTimes(2)
    controller.refresh()
    await flush()
    expect(controller.target).toBe('/downloads')
  })

  it('restores selection and scroll through history, selects the departed child on Up, and drops a forward branch', async () => {
    const { controller } = harness()
    await controller.start()
    controller.select('/downloads/Movies')
    controller.setScrollOffset(144)
    controller.refresh()
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      selected: '/downloads/Movies',
      restore: { offset: 144, reveal: null },
    })
    controller.navigate('/downloads/Movies')
    await flush()
    controller.select('/downloads/Movies/HD')
    controller.setScrollOffset(72)

    controller.history(-1)
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      selected: '/downloads/Movies',
      restore: { offset: 144, reveal: null },
    })
    controller.history(1)
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      selected: '/downloads/Movies/HD',
      restore: { offset: 72, reveal: null },
    })
    controller.up()
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      listing: { path: '/downloads' },
      selected: '/downloads/Movies',
      restore: { reveal: '/downloads/Movies' },
    })

    controller.history(-1)
    await flush()
    controller.navigate('/archive')
    await flush()
    expect(controller.getSnapshot().history.map((entry) => entry.path)).toEqual(
      ['/downloads', '/downloads/Movies', '/archive']
    )
    controller.history(1)
    expect(controller.getSnapshot().busy).toBeNull()
  })

  it('keeps a coherent previous view on failed navigation and clears vanished history selections', async () => {
    const { controller, queue } = harness()
    await controller.start()
    controller.select('/downloads/Movies')
    const original = controller.getSnapshot().listing
    controller.navigate('/missing')
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      listing: original,
      selected: '/downloads/Movies',
      error: 'notFound',
      historyIndex: 0,
    })

    controller.navigate('/archive')
    await flush()
    queue(
      Queries.ListServerDirectories,
      success(listing('/downloads', ['Music']))
    )
    controller.history(-1)
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      selected: null,
      restore: { reveal: null },
    })
  })

  it('freezes validation target and every conflicting action until validation succeeds', async () => {
    const { controller, invoke, finish, queue } = harness()
    await controller.start()
    controller.select('/downloads/Movies')
    const validation = deferred()
    queue(Queries.ValidateServerDirectory, validation.promise)
    const pending = controller.confirm()
    await flush()
    controller.select('/downloads/Music')
    controller.navigate('/archive')
    controller.up()
    controller.history(-1)
    controller.filter(true)
    controller.refresh()
    controller.editPath()
    controller.editName()
    await controller.confirm()
    expect(controller.getSnapshot()).toMatchObject({
      busy: 'validate',
      selected: '/downloads/Movies',
      editor: null,
      showHidden: false,
    })
    expect(invoke).toHaveBeenCalledTimes(4)
    validation.resolve(success({ path: '/downloads/Movies' }))
    await pending
    expect(finish).toHaveBeenCalledExactlyOnceWith('/downloads/Movies')
  })

  it('allows cancellation during validation and ignores its late response', async () => {
    const { controller, finish, queue } = harness()
    await controller.start()
    const validation = deferred()
    queue(Queries.ValidateServerDirectory, validation.promise)
    const pending = controller.confirm()
    await flush()
    controller.cancel()
    validation.resolve(success({ path: '/downloads' }))
    await pending
    expect(finish).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('releases failed validation for correction without settling the picker', async () => {
    const { controller, finish, queue } = harness()
    await controller.start()
    queue(Queries.ValidateServerDirectory, failure('permissionDenied'))
    await controller.confirm()
    expect(controller.getSnapshot()).toMatchObject({
      busy: null,
      error: 'permissionDenied',
    })
    expect(finish).not.toHaveBeenCalled()
    controller.select('/downloads/Music')
    await controller.confirm()
    expect(finish).toHaveBeenCalledExactlyOnceWith('/downloads/Music')
  })

  it('times out bootstrap at 20 seconds and ignores success after a retry has completed', async () => {
    const { controller, queue } = harness()
    const bootstrap = deferred()
    queue(Queries.ListAllowedSaveDirs, bootstrap.promise)
    const pending = controller.start()
    await flush()
    await vi.advanceTimersByTimeAsync(DIRECTORY_OPERATION_TIMEOUT - 1)
    expect(controller.getSnapshot().busy).toBe('bootstrap')
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(controller.getSnapshot()).toMatchObject({
      busy: null,
      error: 'unavailable',
    })
    await controller.start()
    const recovered = controller.getSnapshot()
    bootstrap.resolve({
      paths: [{ path: '/old' }],
      defaultPath: '/old',
      allowCustom: true,
    })
    await flush()
    expect(controller.getSnapshot()).toBe(recovered)
  })

  it('expires navigation and validation independently and rejects late successes', async () => {
    const { controller, finish, queue } = harness()
    await controller.start()
    const navigation = deferred()
    queue(Queries.ListServerDirectories, navigation.promise)
    controller.navigate('/archive')
    await flush()
    await vi.advanceTimersByTimeAsync(DIRECTORY_OPERATION_TIMEOUT)
    expect(controller.getSnapshot()).toMatchObject({
      busy: null,
      error: 'unavailable',
      listing: { path: '/downloads' },
    })
    navigation.resolve(success(listing('/archive', [])))
    await flush()
    expect(controller.target).toBe('/downloads')

    const validation = deferred()
    queue(Queries.ValidateServerDirectory, validation.promise)
    const pending = controller.confirm()
    await flush()
    await vi.advanceTimersByTimeAsync(DIRECTORY_OPERATION_TIMEOUT)
    await pending
    controller.select('/downloads/Music')
    validation.resolve(success({ path: '/downloads' }))
    await flush()
    expect(controller.target).toBe('/downloads/Music')
    expect(finish).not.toHaveBeenCalled()
  })

  it('holds dismissal during creation, then blocks another creation in an unknown parent until refresh succeeds', async () => {
    const { controller, invoke, finish, queue } = harness()
    await controller.start()
    const creation = deferred()
    queue(Commands.CreateServerDirectory, creation.promise)
    controller.editName()
    controller.setEditorText('New folder')
    controller.submitEditor()
    controller.submitEditor()
    await flush()
    controller.cancel()
    controller.cancelEditor()
    controller.navigate('/archive')
    expect(controller.getSnapshot().busy).toBe('create')
    expect(finish).not.toHaveBeenCalled()
    expect(
      invoke.mock.calls.filter(
        ([channel]) => channel === Commands.CreateServerDirectory
      )
    ).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(DIRECTORY_OPERATION_TIMEOUT)
    expect(controller.getSnapshot()).toMatchObject({
      busy: null,
      editor: null,
      notice: 'unknownOutcome',
      unknownParents: ['/downloads'],
    })
    const expired = controller.getSnapshot()
    creation.resolve(
      success({ name: 'New folder', path: '/downloads/New folder' })
    )
    await flush()
    expect(controller.getSnapshot()).toBe(expired)
    controller.editName()
    expect(controller.getSnapshot().editor).toBeNull()

    queue(Queries.ListServerDirectories, failure('unavailable'))
    controller.refresh()
    await flush()
    controller.editName()
    expect(controller.getSnapshot().editor).toBeNull()
    controller.navigate('/archive')
    await flush()
    controller.editName()
    expect(controller.getSnapshot().editor?.kind).toBe('name')
    controller.cancelEditor()
    controller.navigate('/downloads')
    await flush()
    controller.editName()
    expect(controller.getSnapshot().editor).toBeNull()
    controller.refresh()
    await flush()
    expect(controller.getSnapshot().unknownParents).toEqual([])
    controller.editName()
    expect(controller.getSnapshot().editor?.kind).toBe('name')
  })

  it.each(['transport', 'server', 'malformed'])(
    'treats %s creation ambiguity as unknown instead of exposing an automatic retry',
    async (kind) => {
      const { controller, queue } = harness()
      await controller.start()
      const reply = deferred()
      queue(Commands.CreateServerDirectory, reply.promise)
      controller.editName()
      controller.setEditorText('New')
      controller.submitEditor()
      await flush()
      if (kind === 'transport') reply.reject(new Error('Disconnected'))
      else
        reply.resolve(
          kind === 'server' ? failure('creationOutcomeUnknown') : { ok: true }
        )
      await flush()
      expect(controller.getSnapshot()).toMatchObject({
        busy: null,
        editor: null,
        notice: 'unknownOutcome',
        unknownParents: ['/downloads'],
      })
      controller.cancel()
    }
  )

  it.each(['failed', 'capped'])(
    'preserves a known created child when its refresh is %s',
    async (mode) => {
      const { controller, invoke, queue } = harness()
      await controller.start()
      const child = { name: '.New ', path: '/downloads/.New ' }
      queue(Commands.CreateServerDirectory, success(child))
      queue(
        Queries.ListServerDirectories,
        mode === 'failed'
          ? failure('permissionDenied')
          : success({ ...listing(), truncated: true })
      )
      controller.editName()
      controller.setEditorText(child.name)
      controller.submitEditor()
      await flush()
      expect(invoke).toHaveBeenCalledWith(Commands.CreateServerDirectory, {
        parentPath: '/downloads',
        name: '.New ',
      })
      expect(invoke).toHaveBeenLastCalledWith(Queries.ListServerDirectories, {
        path: '/downloads',
        showHidden: true,
      })
      expect(controller.getSnapshot()).toMatchObject({
        selected: child.path,
        showHidden: true,
        editor: null,
        busy: null,
        restore: { reveal: child.path },
      })
      expect(controller.getSnapshot().listing?.entries).toContainEqual(child)
      expect(controller.getSnapshot().notice).toBe(
        mode === 'failed' ? 'refreshAfterCreateFailed' : null
      )
    }
  )

  it('retains rejected creation text and parent so the user can correct the filename', async () => {
    const { controller, invoke, queue } = harness()
    await controller.start()
    queue(
      Commands.CreateServerDirectory,
      failure('alreadyExists'),
      success({ path: '/downloads/Other', name: 'Other' })
    )
    controller.editName()
    controller.setEditorText('Movies')
    controller.submitEditor()
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      busy: null,
      editor: { kind: 'name', text: 'Movies', error: 'alreadyExists' },
      listing: { path: '/downloads' },
    })
    controller.setEditorText('Other')
    controller.submitEditor()
    await flush()
    expect(invoke).toHaveBeenCalledWith(Commands.CreateServerDirectory, {
      parentPath: '/downloads',
      name: 'Other',
    })
    expect(controller.target).toBe('/downloads/Other')
  })

  it('keeps a known child selected across later capped refreshes, then forgets it after a complete listing proves it vanished', async () => {
    const { controller, queue } = harness()
    await controller.start()
    const child = { name: 'New', path: '/downloads/New' }
    queue(Commands.CreateServerDirectory, success(child))
    queue(
      Queries.ListServerDirectories,
      success({ ...listing(), truncated: true })
    )
    controller.editName()
    controller.setEditorText(child.name)
    controller.submitEditor()
    await flush()

    queue(
      Queries.ListServerDirectories,
      success({ ...listing(), truncated: true })
    )
    controller.refresh()
    await flush()
    expect(controller.getSnapshot().selected).toBe(child.path)
    expect(controller.getSnapshot().listing?.entries).toContainEqual(child)

    controller.refresh()
    await flush()
    expect(controller.getSnapshot().selected).toBeNull()
    expect(controller.getSnapshot().listing?.entries).not.toContainEqual(child)
    queue(
      Queries.ListServerDirectories,
      success({ ...listing(), truncated: true })
    )
    controller.refresh()
    await flush()
    expect(controller.getSnapshot().listing?.entries).not.toContainEqual(child)
  })

  it('commits hidden filtering atomically, keeps visible selections and preserves the old filter on failure', async () => {
    const { controller, queue } = harness()
    await controller.start()
    controller.select('/downloads/Movies')
    controller.setScrollOffset(88)
    const filtered = deferred()
    queue(Queries.ListServerDirectories, filtered.promise)
    controller.filter(true)
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      showHidden: false,
      selected: '/downloads/Movies',
      busy: 'navigate',
    })
    filtered.resolve(
      success(listing('/downloads', ['.hidden', 'Movies', 'Music']))
    )
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      showHidden: true,
      selected: '/downloads/Movies',
      restore: { offset: 88 },
    })
    controller.select('/downloads/.hidden')
    queue(Queries.ListServerDirectories, failure('unavailable'))
    controller.filter(false)
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      showHidden: true,
      selected: '/downloads/.hidden',
      error: 'unavailable',
    })
    controller.filter(false)
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      showHidden: false,
      selected: null,
    })
  })

  it.each(['path', 'name'])(
    'locks conflicting controls while the %s editor is open without resetting text',
    async (kind) => {
      const { controller, invoke } = harness()
      await controller.start()
      if (kind === 'path') controller.editPath()
      else controller.editName()
      controller.setEditorText('Uncommitted text')
      controller.editName()
      controller.editPath()
      controller.select('/downloads/Movies')
      controller.navigate('/archive')
      controller.up()
      controller.history(-1)
      controller.refresh()
      controller.filter(true)
      await controller.confirm()
      expect(invoke).toHaveBeenCalledTimes(3)
      expect(controller.getSnapshot()).toMatchObject({
        editor: { kind, text: 'Uncommitted text' },
        selected: null,
        showHidden: false,
        busy: null,
      })
      controller.cancelEditor()
      expect(controller.getSnapshot().editor).toBeNull()
      expect(controller.target).toBe('/downloads')
    }
  )

  it('retains a failed path edit until explicit successful navigation closes it', async () => {
    const { controller, finish } = harness()
    await controller.start()
    controller.editPath()
    controller.setEditorText('/missing')
    controller.submitEditor()
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      editor: { kind: 'path', text: '/missing', error: 'notFound' },
      listing: { path: '/downloads' },
      busy: null,
    })
    controller.setEditorText('/archive')
    controller.submitEditor()
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      editor: null,
      listing: { path: '/archive' },
      selected: null,
    })
    expect(finish).not.toHaveBeenCalled()
  })

  it('cancels a pending path edit and ignores its result after another navigation completes', async () => {
    const { controller, queue } = harness()
    await controller.start()
    const navigation = deferred()
    queue(Queries.ListServerDirectories, navigation.promise)
    controller.editPath()
    controller.setEditorText('/archive')
    controller.submitEditor()
    await flush()
    expect(controller.getSnapshot().busy).toBe('navigate')
    controller.cancelEditor()
    expect(controller.getSnapshot()).toMatchObject({
      editor: null,
      busy: null,
      listing: { path: '/downloads' },
    })
    controller.navigate('/downloads/Music')
    await flush()
    const current = controller.getSnapshot()
    navigation.resolve(success(listing('/archive', [])))
    await flush()
    expect(controller.getSnapshot()).toBe(current)
    expect(controller.target).toBe('/downloads/Music')
  })

  it('invalidates disposed session work without changing a new picker session or notifying old listeners', async () => {
    const old = harness()
    await old.controller.start()
    const response = deferred()
    old.queue(Queries.ListServerDirectories, response.promise)
    old.controller.navigate('/archive')
    await flush()
    const listener = vi.fn()
    old.controller.subscribe(listener)
    const snapshot = old.controller.getSnapshot()
    old.controller.dispose()
    const current = harness('/downloads/Music')
    await current.controller.start()
    response.resolve(success(listing('/archive', [])))
    await flush()
    expect(old.controller.getSnapshot()).toBe(snapshot)
    expect(listener).not.toHaveBeenCalled()
    expect(old.finish).not.toHaveBeenCalled()
    expect(current.controller.target).toBe('/downloads/Music')
    await current.controller.confirm()
    expect(current.finish).toHaveBeenCalledExactlyOnceWith('/downloads/Music')
  })
})
