import {
  type DirectoryPreferencesStore,
  directoryPreferences,
  ServerDirectoryLocationsStore,
} from '@renderer/lib/directory-preferences'
import type { Transport } from '@renderer/lib/transport/types'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type {
  DirectoryPreferences,
  DirectoryPreferencesErrorCode,
} from '@shared/schemas/directory-preferences'
import {
  type AllowedSaveDirs,
  AllowedSaveDirsSchema,
  CreateServerDirectoryResultSchema,
  type DirectoryErrorCode,
  type ListServerDirectoriesResult,
  ListServerDirectoriesResultSchema,
  type ServerDirectoryLocations,
  ValidateServerDirectoryResultSchema,
} from '@shared/schemas/server-directory'
import type { z } from 'zod'

export const DIRECTORY_OPERATION_TIMEOUT = 20_000
export type DirectoryListing = Extract<
  ListServerDirectoriesResult,
  { ok: true }
>['value']
export type DirectoryEntry = DirectoryListing['entries'][number]
type HistoryEntry = { path: string; selected: string | null; offset: number }
type Editor = {
  kind: 'path' | 'name'
  text: string
  error: DirectoryErrorCode | null
}
export type PickerState = {
  locations: ServerDirectoryLocations | null
  locationsLoading: boolean
  locationsError: DirectoryErrorCode | null
  favoriteBusy: boolean
  favoriteError: DirectoryPreferencesErrorCode | null
  bootstrap: AllowedSaveDirs | null
  listing: DirectoryListing | null
  selected: string | null
  showHidden: boolean
  busy: 'bootstrap' | 'navigate' | 'create' | 'validate' | null
  editor: Editor | null
  error: DirectoryErrorCode | null
  notice: 'fallback' | 'refreshAfterCreateFailed' | 'unknownOutcome' | null
  history: HistoryEntry[]
  historyIndex: number
  restore: { revision: number; offset: number; reveal: string | null }
  unknownParents: string[]
}

class DirectoryRequestError extends Error {
  constructor(readonly code: DirectoryErrorCode) {
    super(code)
  }
}

type NavigateOptions = {
  historyIndex?: number
  selected?: string | null
  offset?: number
  refresh?: boolean
  showHidden?: boolean
  created?: DirectoryEntry
  revealSelection?: boolean
}

/** One instance owns one bus request. Disposing invalidates every async continuation. */
export class DirectoryPickerController {
  private state: PickerState = {
    locations: null,
    locationsLoading: false,
    locationsError: null,
    favoriteBusy: false,
    favoriteError: null,
    bootstrap: null,
    listing: null,
    selected: null,
    showHidden: false,
    busy: 'bootstrap',
    editor: null,
    error: null,
    notice: null,
    history: [],
    historyIndex: -1,
    restore: { revision: 0, offset: 0, reveal: null },
    unknownParents: [],
  }
  private listeners = new Set<() => void>()
  private live = true
  private generation = 0
  private pendingDeadlines = new Set<() => void>()
  private scrollOffset = 0
  private knownCreated = new Map<string, DirectoryEntry>()
  private locationsStore: ServerDirectoryLocationsStore
  private unsubscribeLocations?: () => void

  constructor(
    private readonly transport: Pick<Transport, 'invoke'> &
      Partial<Pick<Transport, 'on' | 'off' | 'onConnectionChange'>>,
    private readonly defaultPath: string | undefined,
    private readonly finish: (value: string | null) => void,
    private readonly preferences: Pick<
      DirectoryPreferencesStore,
      'mutate' | 'getSnapshot'
    > = directoryPreferences
  ) {
    this.locationsStore = new ServerDirectoryLocationsStore(transport, {
      retainWhileRefreshing: true,
    })
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<PickerState>) {
    if (!this.live) return
    if (
      Object.entries(patch).every(([key, value]) =>
        Object.is(this.state[key as keyof PickerState], value)
      )
    )
      return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  dispose() {
    this.live = false
    this.generation++
    for (const cancel of this.pendingDeadlines) cancel()
    this.pendingDeadlines.clear()
    this.unsubscribeLocations?.()
    this.locationsStore.dispose()
  }
  private current(generation: number) {
    return this.live && this.generation === generation
  }

  private request<T>(
    channel: Parameters<Transport['invoke']>[0],
    schema: z.ZodType<T>,
    args?: unknown,
    mutation = false
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (value: T | undefined, error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pendingDeadlines.delete(cancel)
        if (error) reject(error)
        else resolve(value as T)
      }
      const cancel = () =>
        done(
          undefined,
          new DirectoryRequestError(
            mutation ? 'creationOutcomeUnknown' : 'unavailable'
          )
        )
      const timer = setTimeout(cancel, DIRECTORY_OPERATION_TIMEOUT)
      this.pendingDeadlines.add(cancel)
      // Invocation and parsing share the deadline; neither late success nor failure is committed.
      Promise.resolve()
        .then(() =>
          args === undefined
            ? this.transport.invoke(channel)
            : this.transport.invoke(channel, args)
        )
        .then((value) => done(schema.parse(value)))
        .catch(() => cancel())
    })
  }
  private errorCode(error: unknown): DirectoryErrorCode {
    return error instanceof DirectoryRequestError ? error.code : 'unavailable'
  }
  private async list(path: string, showHidden: boolean) {
    const result = await this.request(
      Queries.ListServerDirectories,
      ListServerDirectoriesResultSchema,
      { path, showHidden }
    )
    if (!result.ok) throw new DirectoryRequestError(result.error.code)
    return result.value
  }

  async start() {
    if (!this.live) return
    if (!this.unsubscribeLocations) {
      this.unsubscribeLocations = this.locationsStore.subscribe(() => {
        const { locations, loading, error } = this.locationsStore.getSnapshot()
        this.update({
          locations,
          locationsLoading: loading,
          locationsError: error,
        })
      })
    }
    const generation = ++this.generation
    this.update({ busy: 'bootstrap', error: null })
    try {
      const bootstrap = await this.request(
        Queries.ListAllowedSaveDirs,
        AllowedSaveDirsSchema
      )
      if (!this.current(generation)) return
      this.update({ bootstrap })
      const candidates = [
        ...new Set(
          [
            this.defaultPath,
            bootstrap.defaultPath,
            ...bootstrap.paths.map((root) => root.path),
          ].filter((path): path is string => path !== undefined && path !== '')
        ),
      ]
      let lastError: DirectoryErrorCode = 'invalidPath'
      for (let index = 0; index < candidates.length; index++) {
        try {
          const listing = await this.list(candidates[index], false)
          if (!this.current(generation)) return
          this.commitListing(listing, {}, false)
          if (index > 0) this.update({ notice: 'fallback' })
          return
        } catch (error) {
          if (!this.current(generation)) return
          lastError = this.errorCode(error)
        }
      }
      this.update({ busy: null, error: lastError })
    } catch (error) {
      if (this.current(generation))
        this.update({ busy: null, error: this.errorCode(error) })
    }
  }

  get locked() {
    return this.state.busy !== null || this.state.editor !== null
  }
  get target() {
    return this.state.selected ?? this.state.listing?.path ?? null
  }
  get currentFavorite() {
    const path = this.state.listing?.path
    return this.state.locations?.favorites.find(
      (entry) =>
        path !== undefined &&
        (entry.path === path || entry.sourcePaths.includes(path))
    )
  }
  refreshLocations() {
    void this.locationsStore.refresh()
  }
  async toggleFavorite() {
    const path = this.state.listing?.path
    if (
      !this.live ||
      this.locked ||
      !path ||
      !this.state.locations ||
      this.state.locationsLoading ||
      this.state.favoriteBusy
    )
      return
    const favorite = this.currentFavorite
    const revision = this.locationsStore.getRevision()
    let committed: DirectoryPreferences | undefined
    this.update({ favoriteBusy: true, favoriteError: null })
    const success = await this.preferences.mutate(
      favorite
        ? { action: 'removeFavorite', paths: favorite.sourcePaths }
        : { action: 'addFavorite', path },
      (snapshot) => {
        committed = snapshot
      }
    )
    if (!this.live) return
    // Only a locations query associated with this committed snapshot can cover
    // the write. An unrelated client's event must not suppress this refresh.
    await this.locationsStore.refreshAfterMutation(revision, committed)
    if (!this.live) return
    this.update({
      favoriteBusy: false,
      favoriteError: success
        ? null
        : (this.preferences.getSnapshot().error ?? 'unavailable'),
    })
  }
  setScrollOffset(offset: number) {
    this.scrollOffset = offset
  }
  select(path: string | null) {
    if (
      this.locked ||
      (path !== null &&
        !this.state.listing?.entries.some((entry) => entry.path === path))
    )
      return
    this.update({ selected: path })
  }
  private commitListing(
    listing: DirectoryListing,
    options: NavigateOptions,
    showHidden: boolean
  ) {
    const { state } = this
    const known = this.knownCreated.get(listing.path)
    if (
      known &&
      !listing.truncated &&
      !options.created &&
      (showHidden || !known.name.startsWith('.')) &&
      !listing.entries.some((entry) => entry.path === known.path)
    ) {
      this.knownCreated.delete(listing.path)
    }
    if (
      listing.truncated &&
      known &&
      (showHidden || !known.name.startsWith('.')) &&
      !listing.entries.some((entry) => entry.path === known.path)
    ) {
      listing = { ...listing, entries: [known, ...listing.entries] }
    }
    if (
      options.created &&
      !listing.entries.some((entry) => entry.path === options.created?.path)
    ) {
      listing = { ...listing, entries: [options.created, ...listing.entries] }
    }
    const desired = options.created?.path ?? options.selected ?? null
    const selected = listing.entries.some((entry) => entry.path === desired)
      ? desired
      : null
    let history = state.history.map((entry, index) =>
      index === state.historyIndex
        ? { ...entry, selected: state.selected, offset: this.scrollOffset }
        : entry
    )
    let historyIndex = state.historyIndex
    if (options.historyIndex !== undefined) {
      historyIndex = options.historyIndex
    } else if (!options.refresh) {
      history = history.slice(0, historyIndex + 1)
      history.push({ path: listing.path, selected, offset: 0 })
      historyIndex++
    }
    if (historyIndex >= 0)
      history[historyIndex] = {
        path: listing.path,
        selected,
        offset: options.offset ?? 0,
      }
    this.scrollOffset = options.offset ?? 0
    this.update({
      listing,
      selected,
      showHidden,
      history,
      historyIndex,
      busy: null,
      editor: null,
      error: null,
      notice: null,
      unknownParents: options.refresh
        ? state.unknownParents.filter((path) => path !== listing.path)
        : state.unknownParents,
      restore: {
        revision: state.restore.revision + 1,
        offset: this.scrollOffset,
        reveal: options.revealSelection || options.created ? selected : null,
      },
    })
  }
  private async load(path: string, options: NavigateOptions = {}) {
    const generation = ++this.generation
    const showHidden = options.showHidden ?? this.state.showHidden
    this.update({ busy: 'navigate', error: null })
    try {
      const listing = await this.list(path, showHidden)
      if (!this.current(generation)) return
      this.commitListing(listing, options, showHidden)
    } catch (error) {
      if (!this.current(generation)) return
      const code = this.errorCode(error)
      if (options.created && this.state.listing) {
        const entries = this.state.listing.entries.filter(
          (entry) => entry.path !== options.created?.path
        )
        this.update({
          listing: {
            ...this.state.listing,
            entries: [options.created, ...entries],
          },
          selected: options.created.path,
          busy: null,
          editor: null,
          showHidden,
          error: code,
          notice: 'refreshAfterCreateFailed',
          restore: {
            revision: this.state.restore.revision + 1,
            offset: 0,
            reveal: options.created.path,
          },
        })
      } else {
        this.update({
          busy: null,
          error: code,
          editor: this.state.editor
            ? { ...this.state.editor, error: code }
            : null,
        })
      }
    }
  }
  navigate(path: string) {
    if (this.live && !this.locked) void this.load(path)
  }
  navigateLocation(path: string) {
    if (this.state.bootstrap?.paths.some((entry) => entry.path === path)) {
      this.navigate(path)
      return
    }
    const locations = this.state.locations
    if (!this.live || this.locked || this.state.locationsLoading || !locations)
      return
    const known = [
      ...locations.common,
      ...locations.favorites,
      ...locations.recent,
    ]
    if (known.some((entry) => entry.path === path)) this.navigate(path)
  }
  up() {
    if (!this.locked && this.state.listing?.parentPath)
      void this.load(this.state.listing.parentPath, {
        selected: this.state.listing.path,
        revealSelection: true,
      })
  }
  history(delta: -1 | 1) {
    if (this.locked) return
    const index = this.state.historyIndex + delta
    const entry = this.state.history[index]
    if (entry)
      void this.load(entry.path, {
        historyIndex: index,
        selected: entry.selected,
        offset: entry.offset,
      })
  }
  refresh() {
    if (this.locked) return
    if (!this.state.listing) {
      void this.start()
      return
    }
    void this.load(this.state.listing.path, {
      refresh: true,
      selected: this.state.selected,
      offset: this.scrollOffset,
    })
  }
  filter(showHidden: boolean) {
    if (
      !this.live ||
      this.locked ||
      !this.state.listing ||
      showHidden === this.state.showHidden
    )
      return
    void this.load(this.state.listing.path, {
      refresh: true,
      showHidden,
      selected: this.state.selected,
      offset: this.scrollOffset,
    })
  }
  editPath() {
    if (!this.locked && this.state.listing)
      this.update({
        editor: { kind: 'path', text: this.state.listing.path, error: null },
        error: null,
      })
  }
  editName() {
    if (
      this.locked ||
      !this.state.listing?.canCreate ||
      this.state.unknownParents.includes(this.state.listing.path)
    )
      return
    this.update({
      editor: { kind: 'name', text: '', error: null },
      error: null,
    })
  }
  setEditorText(text: string) {
    if (!this.state.busy && this.state.editor)
      this.update({ editor: { ...this.state.editor, text, error: null } })
  }
  cancelEditor() {
    if (
      this.state.editor &&
      (this.state.busy === null ||
        (this.state.editor.kind === 'path' && this.state.busy === 'navigate'))
    ) {
      this.generation++
      this.update({ editor: null, error: null })
      this.update({ busy: null })
    }
  }
  submitEditor() {
    if (this.state.busy || !this.state.editor) return
    if (this.state.editor.kind === 'path') {
      if (this.state.editor.text === '') {
        this.update({ editor: { ...this.state.editor, error: 'invalidPath' } })
        return
      }
      void this.load(this.state.editor.text)
    } else void this.create()
  }
  private async create() {
    const parentPath = this.state.listing?.path
    const editor = this.state.editor
    if (
      !parentPath ||
      editor?.kind !== 'name' ||
      this.state.unknownParents.includes(parentPath)
    )
      return
    if (editor.text === '') {
      this.update({ editor: { ...editor, error: 'invalidName' } })
      return
    }
    const generation = ++this.generation
    this.update({ busy: 'create', error: null })
    try {
      const result = await this.request(
        Commands.CreateServerDirectory,
        CreateServerDirectoryResultSchema,
        { parentPath, name: editor.text },
        true
      )
      if (!this.current(generation)) return
      if (!result.ok) throw new DirectoryRequestError(result.error.code)
      this.knownCreated.set(parentPath, result.value)
      this.update({ editor: null })
      await this.load(parentPath, {
        refresh: true,
        created: result.value,
        showHidden: this.state.showHidden || result.value.name.startsWith('.'),
      })
    } catch (error) {
      if (!this.current(generation)) return
      const code = this.errorCode(error)
      if (code === 'creationOutcomeUnknown') {
        this.update({
          busy: null,
          editor: null,
          error: null,
          notice: 'unknownOutcome',
          unknownParents: [
            ...new Set([...this.state.unknownParents, parentPath]),
          ],
        })
      } else this.update({ busy: null, editor: { ...editor, error: code } })
    }
  }
  async confirm() {
    const target = this.target
    if (this.locked || !target) return
    const generation = ++this.generation
    this.update({ busy: 'validate', error: null })
    try {
      const result = await this.request(
        Queries.ValidateServerDirectory,
        ValidateServerDirectoryResultSchema,
        { path: target }
      )
      if (!this.current(generation) || this.target !== target) return
      if (!result.ok) throw new DirectoryRequestError(result.error.code)
      this.dispose()
      this.finish(result.value.path)
    } catch (error) {
      if (this.current(generation))
        this.update({ busy: null, error: this.errorCode(error) })
    }
  }
  cancel() {
    if (!this.live || this.state.busy === 'create') return
    this.dispose()
    this.finish(null)
  }
}
