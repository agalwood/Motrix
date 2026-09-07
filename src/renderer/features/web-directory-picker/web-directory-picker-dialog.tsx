import type { VirtualListHandle } from '@renderer/components/desktop-kit/virtual-list/types'
import { VirtualList } from '@renderer/components/desktop-kit/virtual-list/virtual-list'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import {
  __webPathPickerBus,
  type PickRequest,
} from '@renderer/platform/web-services'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Star,
  X,
} from 'lucide-react'
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'
import { DirectoryPickerController } from './directory-picker-controller'

const ROW_HEIGHT = 32

export function isMacClient() {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
}

function validOpener(opener: HTMLElement | null): boolean {
  return (
    !!opener?.isConnected &&
    !opener.matches(':disabled, [aria-disabled="true"]') &&
    !opener.closest('[inert], [aria-hidden="true"]')
  )
}

function restoreOpener(request: PickRequest) {
  // The caller re-enables its Browse button when the promise settles.
  let attempts = 0
  const restore = () => {
    if (!__webPathPickerBus.canRestoreFocus(request.id)) return
    if (validOpener(request.opener))
      request.opener?.focus({ preventScroll: true })
    else if (request.opener?.isConnected && ++attempts < 8)
      requestAnimationFrame(restore)
  }
  requestAnimationFrame(() => requestAnimationFrame(restore))
}

type Session = { request: PickRequest; controller: DirectoryPickerController }

export function WebDirectoryPickerDialog() {
  const [session, setSession] = useState<Session | null>(null)
  const current = useRef<Session | null>(null)
  useEffect(() => {
    const unsubscribe = __webPathPickerBus.subscribe((request) => {
      current.current?.controller.dispose()
      const controller = new DirectoryPickerController(
        transport,
        request.defaultPath,
        (value) => {
          if (current.current?.request.id !== request.id) return
          current.current = null
          setSession(null)
          __webPathPickerBus.resolve(request.id, value)
          restoreOpener(request)
        }
      )
      current.current = { request, controller }
      setSession(current.current)
    })
    return () => {
      current.current?.controller.dispose()
      current.current = null
      unsubscribe()
    }
  }, [])
  return session ? (
    <PickerSession key={session.request.id} {...session} />
  ) : null
}

function PickerSession({ request, controller }: Session) {
  const { t } = useTranslation()
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot
  )
  const listRef = useRef<HTMLDivElement>(null)
  const virtualRef = useRef<VirtualListHandle>(null)
  const editorRef = useRef<HTMLInputElement>(null)
  const rootSidebarRef = useRef<HTMLElement>(null)
  const rootSelectRef = useRef<HTMLSelectElement>(null)
  const lastFocused = useRef<HTMLElement | null>(null)
  const id = useId()
  const mac = isMacClient()
  const typeahead = useRef({ text: '', time: 0 })
  const entries = state.listing?.entries ?? []
  const activeIndex = entries.findIndex(
    (entry) => entry.path === state.selected
  )
  const locked = state.busy !== null || state.editor !== null
  const creating = state.busy === 'create'
  const target = state.selected ?? state.listing?.path
  const unknown =
    !!state.listing && state.unknownParents.includes(state.listing.path)
  const seenCommon = new Set<string>()
  const common = (state.locations?.common ?? []).filter((entry) => {
    if (seenCommon.has(entry.path)) return false
    seenCommon.add(entry.path)
    return true
  })
  const groups = [
    {
      id: 'common',
      label: t('directoryPicker.places.common'),
      items: common.map((entry) => ({
        path: entry.path,
        name: t(`directoryPicker.places.${entry.kind}`),
      })),
    },
    {
      id: 'allowed',
      label: t('directoryPicker.places.allowed'),
      items: (state.bootstrap?.paths ?? [])
        .filter((entry) => !seenCommon.has(entry.path))
        .map((entry) => ({ path: entry.path, name: entry.path })),
    },
    {
      id: 'favorites',
      label: t('directoryPreferences.favorites'),
      items: state.locations?.favorites ?? [],
    },
    {
      id: 'recent',
      label: t('directoryPreferences.recent'),
      items: state.locations?.recent ?? [],
    },
  ].filter((group) => group.items.length > 0)
  const activeLocation = groups
    .flatMap((group) => group.items)
    .sort((a, b) => b.path.length - a.path.length)
    .find((entry) =>
      state.listing?.breadcrumbs.some((crumb) => crumb.path === entry.path)
    )?.path
  const favorite = controller.currentFavorite

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const desktop = window.matchMedia('(min-width: 640px)')
    const restoreVisibleFocus = () => {
      const active = document.activeElement
      const candidate =
        active === document.body || active === document.documentElement
          ? lastFocused.current
          : active
      if (
        (!desktop.matches &&
          candidate &&
          rootSidebarRef.current?.contains(candidate)) ||
        (desktop.matches &&
          candidate === rootSelectRef.current &&
          candidate !== null)
      )
        listRef.current?.focus({ preventScroll: true })
    }
    desktop.addEventListener('change', restoreVisibleFocus)
    return () => desktop.removeEventListener('change', restoreVisibleFocus)
  }, [])

  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void controller.start()
  }, [controller])
  const editorKind = state.editor?.kind
  const previousEditorKind = useRef(editorKind)
  useLayoutEffect(() => {
    // Disabling a focused control can move browser focus to body. Keep every
    // pending operation inside the modal's keyboard boundary before paint.
    if (state.busy) {
      listRef.current?.focus({ preventScroll: true })
    } else if (editorKind) {
      editorRef.current?.focus()
      if (previousEditorKind.current !== editorKind) editorRef.current?.select()
    }
    previousEditorKind.current = editorKind
  }, [editorKind, state.busy])
  useLayoutEffect(() => {
    const previous = lastFocused.current
    // Remote updates can remove the compact Location select or disable the
    // favorite button without a local click. Reclaim focus before paint so a
    // following submit shortcut stays inside this modal.
    if (
      previous &&
      previous !== listRef.current &&
      (!previous.isConnected ||
        previous.matches(':disabled, [aria-disabled="true"]'))
    )
      listRef.current?.focus({ preventScroll: true })
  })
  const currentPath = state.listing?.path
  useLayoutEffect(() => {
    if (currentPath !== undefined) typeahead.current = { text: '', time: 0 }
  }, [currentPath])
  useEffect(() => {
    if (state.restore.revision === 0) return
    virtualRef.current?.scrollToOffset(state.restore.offset)
    if (state.restore.reveal) {
      const index = entries.findIndex(
        (entry) => entry.path === state.restore.reveal
      )
      if (index >= 0) virtualRef.current?.scrollToIndex(index)
    }
    listRef.current?.focus({ preventScroll: true })
  }, [state.restore, entries])

  const cancelEditor = () => {
    controller.cancelEditor()
    listRef.current?.focus({ preventScroll: true })
  }
  const move = (index: number) => {
    if (entries.length === 0) return
    const next = Math.max(0, Math.min(entries.length - 1, index))
    controller.select(entries[next].path)
    virtualRef.current?.scrollToIndex(next)
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    const plain =
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    const meta =
      event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    const alt =
      event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    if (
      plain &&
      event.repeat &&
      (event.key === 'Enter' || event.key === ' ') &&
      (event.target as HTMLElement).closest('button')
    ) {
      event.preventDefault()
      return
    }
    if (event.key === 'Escape' && plain) {
      event.preventDefault()
      if (event.repeat || creating) return
      if (state.editor) cancelEditor()
      else controller.cancel()
      return
    }
    if (state.editor) {
      if (
        event.target === editorRef.current &&
        event.key === 'Enter' &&
        plain
      ) {
        event.preventDefault()
        if (!event.repeat) controller.submitEditor()
      }
      return
    }
    if (locked) return
    if (
      mac &&
      event.metaKey &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      ['g', 'h', 'd', 'o'].includes(event.key.toLowerCase())
    ) {
      const key = event.key.toLowerCase()
      if (key === 'g') {
        event.preventDefault()
        if (!event.repeat) controller.editPath()
      } else {
        const kind =
          key === 'h' ? 'home' : key === 'd' ? 'desktop' : 'documents'
        const location = state.locations?.common.find(
          (entry) => entry.kind === kind
        )
        if (location) {
          event.preventDefault()
          if (!event.repeat) controller.navigate(location.path)
        }
      }
      return
    }
    if (event.target !== listRef.current) return
    const page = Math.max(
      1,
      Math.floor((listRef.current?.clientHeight ?? 256) / ROW_HEIGHT)
    )
    if (
      plain &&
      ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(
        event.key
      )
    ) {
      event.preventDefault()
      if (event.key === 'ArrowDown') move(activeIndex < 0 ? 0 : activeIndex + 1)
      else if (event.key === 'ArrowUp')
        move(activeIndex < 0 ? entries.length - 1 : activeIndex - 1)
      else if (event.key === 'Home') move(0)
      else if (event.key === 'End') move(entries.length - 1)
      else if (event.key === 'PageDown')
        move(activeIndex < 0 ? 0 : activeIndex + page)
      else move(activeIndex < 0 ? entries.length - 1 : activeIndex - page)
      return
    }
    if (
      (mac && meta && event.key === 'ArrowUp') ||
      (!mac &&
        ((alt && event.key === 'ArrowUp') ||
          (plain && event.key === 'Backspace')))
    ) {
      event.preventDefault()
      if (!event.repeat) controller.up()
    } else if (
      (mac && meta && event.key === 'ArrowDown') ||
      (!mac && plain && event.key === 'Enter')
    ) {
      event.preventDefault()
      if (!event.repeat && state.selected) controller.navigate(state.selected)
    } else if (mac && plain && event.key === 'Enter') {
      event.preventDefault()
      if (!event.repeat) void controller.confirm()
    } else if (plain && event.key === '/') {
      event.preventDefault()
      if (!event.repeat) controller.editPath()
    } else if (plain && event.key === ' ') {
      event.preventDefault()
    } else if (plain && event.key.length === 1) {
      event.preventDefault()
      const now = Date.now()
      const character = event.key.toLocaleLowerCase()
      const previous =
        now - typeahead.current.time <= 700 ? typeahead.current.text : ''
      const text =
        previous && [...previous].every((value) => value === character)
          ? character
          : previous + character
      typeahead.current = { text, time: now }
      const start =
        text.length === 1 ? activeIndex + 1 : Math.max(activeIndex, 0)
      for (let offset = 0; offset < entries.length; offset++) {
        const index = (start + offset) % entries.length
        if (entries[index].name.toLocaleLowerCase().startsWith(text)) {
          move(index)
          break
        }
      }
    }
  }
  const editor = state.editor
  const editorError = editor?.error

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (open) return
        if (creating) {
          details.cancel()
          return
        }
        if (details.reason === 'escape-key' && editor) {
          details.cancel()
          cancelEditor()
          return
        }
        controller.cancel()
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={listRef}
        finalFocus={() =>
          __webPathPickerBus.canRestoreFocus(request.id)
            ? validOpener(request.opener)
              ? request.opener
              : true
            : false
        }
        onFocusCapture={(event) => {
          lastFocused.current = event.target as HTMLElement
        }}
        onKeyDown={keyDown}
        onKeyUp={(event) => event.stopPropagation()}
        className="flex h-[500px] max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[720px] flex-row gap-0 overflow-hidden p-0 sm:max-w-[720px]"
        data-testid="web-directory-picker"
      >
        {groups.length > 0 && (
          <nav
            ref={rootSidebarRef}
            aria-label={t('directoryPicker.location')}
            data-testid="directory-picker-locations"
            className="hidden w-40 shrink-0 flex-col gap-2 overflow-y-auto border-e bg-muted/40 p-2 sm:flex"
          >
            {groups.map((group) => (
              <div key={group.id} data-directory-location-group={group.id}>
                <p className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
                  {group.label}
                </p>
                {group.items.map((entry) => (
                  <Button
                    key={entry.path}
                    data-directory-location
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'w-full justify-start gap-2 px-2 text-xs',
                      activeLocation === entry.path &&
                        'bg-accent text-accent-foreground'
                    )}
                    disabled={locked}
                    aria-label={entry.name}
                    aria-current={
                      activeLocation === entry.path ? 'location' : undefined
                    }
                    title={entry.path}
                    onClick={() => controller.navigate(entry.path)}
                  >
                    {group.id === 'favorites' ? (
                      <Star className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span dir="ltr" className="truncate whitespace-pre">
                      {entry.name}
                    </span>
                  </Button>
                ))}
              </div>
            ))}
          </nav>
        )}
        <div
          data-testid="directory-picker-main"
          className="flex min-w-0 flex-1 flex-col"
        >
          <div className="relative shrink-0 space-y-0.5 px-3 pt-3 pb-2 pe-11">
            <DialogTitle className="text-[13px]">
              {t('directoryPicker.title')}
            </DialogTitle>
            <DialogDescription className="text-[11px] leading-4">
              {t('directoryPicker.description')}
            </DialogDescription>
            <DialogClose
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={creating}
                  aria-label={t('chrome.close')}
                  className="absolute top-2 right-2"
                />
              }
            >
              <X />
            </DialogClose>
          </div>
          <div
            data-testid="directory-picker-toolbar"
            className="flex shrink-0 items-center gap-1 border-b px-3 pb-2"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className={editor?.kind === 'path' ? 'hidden' : undefined}
              aria-label={t('directoryPicker.back')}
              title={t('directoryPicker.back')}
              disabled={locked || state.historyIndex <= 0}
              onClick={() => controller.history(-1)}
            >
              <ArrowLeft />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={editor?.kind === 'path' ? 'hidden' : undefined}
              aria-label={t('directoryPicker.forward')}
              title={t('directoryPicker.forward')}
              disabled={
                locked || state.historyIndex >= state.history.length - 1
              }
              onClick={() => controller.history(1)}
            >
              <ArrowRight />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={editor?.kind === 'path' ? 'hidden' : undefined}
              aria-label={t('directoryPicker.up')}
              title={`${t('directoryPicker.up')} (${mac ? '⌘ ↑' : 'Alt ↑'})`}
              disabled={locked || !state.listing?.parentPath}
              onClick={() => controller.up()}
            >
              <ArrowUp />
            </Button>
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {editor?.kind === 'path' ? (
                <>
                  <Input
                    ref={editorRef}
                    aria-label={t('directoryPicker.path')}
                    aria-invalid={!!editorError}
                    aria-describedby={
                      editorError ? `${id}-editor-error` : undefined
                    }
                    value={editor.text}
                    maxLength={4096}
                    disabled={!!state.busy}
                    onChange={(event) =>
                      controller.setEditorText(event.target.value)
                    }
                    dir="ltr"
                    className="h-8 min-w-0 flex-1"
                  />
                  <Button
                    size="sm"
                    disabled={!!state.busy}
                    onClick={() => controller.submitEditor()}
                  >
                    {t('directoryPicker.go')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={creating}
                    onClick={cancelEditor}
                  >
                    {t('common.cancel')}
                  </Button>
                </>
              ) : (
                <>
                  <nav
                    aria-label={t('directoryPicker.path')}
                    dir="ltr"
                    className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-md border bg-background px-1"
                  >
                    {state.listing?.breadcrumbs.map((crumb, index) => (
                      <span
                        key={crumb.path}
                        className="flex shrink-0 items-center"
                      >
                        {index > 0 &&
                          state.listing?.breadcrumbs[index - 1]?.name !==
                            '/' && (
                            <span aria-hidden className="text-muted-foreground">
                              /
                            </span>
                          )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 max-w-40 truncate px-1.5 text-xs"
                          title={crumb.path}
                          disabled={locked}
                          onClick={() => controller.navigate(crumb.path)}
                        >
                          {crumb.name}
                        </Button>
                      </span>
                    ))}
                    {!state.listing && <span className="h-7" />}
                  </nav>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('directoryPicker.goToFolder')}
                    title={`${t('directoryPicker.goToFolder')} (${mac ? '⌘ ⇧ G /' : '/'})`}
                    disabled={locked || !state.listing}
                    onClick={() => controller.editPath()}
                  >
                    <Pencil />
                  </Button>
                </>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className={editor?.kind === 'path' ? 'hidden' : undefined}
              data-testid="directory-picker-favorite"
              aria-label={t(
                favorite
                  ? 'directoryPreferences.removeFavorite'
                  : 'directoryPreferences.addFavorite'
              )}
              title={t(
                favorite
                  ? 'directoryPreferences.removeFavorite'
                  : 'directoryPreferences.addFavorite'
              )}
              aria-pressed={!!favorite}
              disabled={
                locked ||
                !state.listing ||
                !state.locations ||
                state.locationsLoading ||
                state.favoriteBusy
              }
              onClick={() => {
                listRef.current?.focus({ preventScroll: true })
                void controller.toggleFavorite()
              }}
            >
              <Star className={favorite ? 'fill-current' : undefined} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={editor?.kind === 'path' ? 'hidden' : undefined}
              aria-label={t('directoryPicker.refresh')}
              title={t('directoryPicker.refresh')}
              disabled={locked}
              onClick={() => controller.refresh()}
            >
              <RefreshCw
                className={
                  state.busy === 'navigate'
                    ? 'animate-spin motion-reduce:animate-none'
                    : undefined
                }
              />
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-1.5">
              {groups.length > 0 && (
                <label className="flex min-w-0 flex-1 items-center gap-2 text-[11px] sm:hidden">
                  {t('directoryPicker.location')}
                  <select
                    ref={rootSelectRef}
                    aria-label={t('directoryPicker.location')}
                    disabled={locked}
                    value={activeLocation ?? ''}
                    onChange={(event) =>
                      controller.navigate(event.target.value)
                    }
                    className="h-6 min-w-0 flex-1 rounded border bg-background px-1"
                    dir="ltr"
                  >
                    <option value="" disabled>
                      —
                    </option>
                    {groups.map((group) => (
                      <optgroup key={group.id} label={group.label}>
                        {group.items.map((entry) => (
                          <option key={entry.path} value={entry.path}>
                            {entry.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              )}
              <label
                htmlFor={`${id}-hidden`}
                className="ms-auto flex shrink-0 items-center gap-2 text-[11px]"
              >
                <Switch
                  id={`${id}-hidden`}
                  size="sm"
                  checked={state.showHidden}
                  disabled={locked || !state.listing}
                  onCheckedChange={(checked) => controller.filter(checked)}
                  aria-label={t('directoryPicker.showHidden')}
                />
                {t('directoryPicker.showHidden')}
              </label>
            </div>
            {state.locationsError && (
              <div
                role="status"
                className="flex shrink-0 items-center gap-2 px-3 py-1 text-[11px] text-muted-foreground"
              >
                <p className="flex-1">
                  {t('directoryPicker.places.loadFailed')}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={state.locationsLoading}
                  onClick={() => {
                    listRef.current?.focus({ preventScroll: true })
                    controller.refreshLocations()
                  }}
                >
                  {t('directoryPicker.retry')}
                </Button>
              </div>
            )}
            {state.favoriteError && (
              <p
                role="alert"
                className="shrink-0 px-3 py-1 text-xs text-destructive"
              >
                {t(`directoryPreferences.errors.${state.favoriteError}`)}
              </p>
            )}
            {editor?.kind === 'name' && (
              <div className="shrink-0 space-y-2 border-b px-3 py-2">
                <div className="flex items-center gap-2">
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <Input
                    ref={editorRef}
                    aria-label={t('directoryPicker.folderName')}
                    aria-invalid={!!editorError}
                    aria-describedby={`${id}-create-help${editorError ? ` ${id}-editor-error` : ''}`}
                    value={editor.text}
                    maxLength={255}
                    disabled={creating}
                    onChange={(event) =>
                      controller.setEditorText(event.target.value)
                    }
                    dir="ltr"
                    className="h-8 min-w-0 flex-1"
                  />
                  <Button
                    size="sm"
                    disabled={creating}
                    onClick={() => controller.submitEditor()}
                  >
                    {t('directoryPicker.create')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={creating}
                    onClick={cancelEditor}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
                <p
                  id={`${id}-create-help`}
                  className="text-xs text-muted-foreground"
                >
                  {t('directoryPicker.createHelp')}
                </p>
              </div>
            )}
            {editorError && (
              <p
                role="alert"
                id={`${id}-editor-error`}
                className="shrink-0 px-3 py-2 text-xs text-destructive"
              >
                {t(`directoryPicker.errors.${editorError}`)}
              </p>
            )}
            {!editorError && state.error && (
              <div
                role="alert"
                className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs text-destructive"
              >
                <p className="flex-1">
                  {t(`directoryPicker.errors.${state.error}`)}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={locked}
                  onClick={() => controller.refresh()}
                >
                  {t('directoryPicker.retry')}
                </Button>
              </div>
            )}
            {(state.notice || unknown) && (
              <p
                role="status"
                className="shrink-0 px-3 py-2 text-xs text-muted-foreground"
              >
                {t(
                  `directoryPicker.${unknown ? 'unknownOutcome' : (state.notice ?? 'unknownOutcome')}`,
                  { path: state.listing?.path }
                )}
              </p>
            )}
            {state.listing?.truncated && (
              <p className="shrink-0 px-3 py-2 text-xs text-muted-foreground">
                {t('directoryPicker.incomplete')}
              </p>
            )}
            <VirtualList
              ref={virtualRef}
              scrollRef={listRef}
              activeIndex={activeIndex}
              items={entries}
              getId={(entry) => entry.path}
              rowHeight={ROW_HEIGHT}
              className="min-h-0 flex-1 bg-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              containerProps={{
                role: 'listbox',
                tabIndex: 0,
                'aria-label': t('directoryPicker.folders'),
                'aria-activedescendant':
                  activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined,
                'aria-busy': !!state.busy,
                'aria-disabled': locked,
                onScroll: (event) =>
                  controller.setScrollOffset(event.currentTarget.scrollTop),
                onClick: (event) => {
                  if (!(event.target as HTMLElement).closest('[role="option"]'))
                    controller.select(null)
                },
              }}
              renderEmpty={() => (
                <p className="p-6 text-center text-xs text-muted-foreground">
                  {state.busy
                    ? t('directoryPicker.loading')
                    : state.listing
                      ? t('directoryPicker.empty')
                      : ''}
                </p>
              )}
              renderRow={({ item, index, style }) => (
                // biome-ignore lint/a11y/useKeyWithClickEvents: The owning listbox handles keyboard selection and retains DOM focus.
                <div
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-posinset={index + 1}
                  aria-setsize={entries.length}
                  aria-selected={state.selected === item.path}
                  aria-disabled={locked}
                  tabIndex={-1}
                  style={style}
                  title={item.name}
                  className={cn(
                    'flex cursor-default items-center gap-2 px-3 text-sm select-none',
                    state.selected === item.path
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50',
                    locked && 'opacity-60'
                  )}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    listRef.current?.focus({ preventScroll: true })
                  }}
                  onClick={() => controller.select(item.path)}
                  onDoubleClick={() => controller.navigate(item.path)}
                >
                  <Folder
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span dir="ltr" className="truncate whitespace-pre">
                    {item.name}
                  </span>
                </div>
              )}
            />
          </div>
          <div className="flex min-w-0 shrink-0 items-start gap-2 border-t px-3 pt-2 text-[11px]">
            <span className="shrink-0 text-muted-foreground">
              {t('directoryPicker.selectedPath')}
            </span>
            <p
              dir="ltr"
              className="min-w-0 max-h-12 flex-1 overflow-auto break-all whitespace-pre-wrap"
              data-testid="directory-picker-target"
            >
              {target ?? '—'}
            </p>
          </div>
          <div
            data-testid="directory-picker-actions"
            className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 pt-2 pb-3"
          >
            <Button
              variant="outline"
              size="sm"
              disabled={locked || !state.listing?.canCreate || unknown}
              onClick={() => controller.editName()}
            >
              <FolderPlus />
              {t('directoryPicker.newFolder')}
            </Button>
            <div className="ms-auto flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={creating}
                onClick={() => controller.cancel()}
              >
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                disabled={locked || !target}
                onClick={() => void controller.confirm()}
              >
                {t('directoryPicker.selectFolder')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
