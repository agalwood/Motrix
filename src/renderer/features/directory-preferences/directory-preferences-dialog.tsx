import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useDirectoryPreferences } from '@renderer/lib/directory-preferences'
import { usePlatformServices } from '@renderer/platform/services'
import {
  DIRECTORY_FAVORITES_LIMIT,
  DIRECTORY_RECENT_LIMIT,
  type MutateDirectoryPreferencesRequest,
} from '@shared/schemas/directory-preferences'
import { Folder, FolderPlus, Star, Trash2 } from 'lucide-react'
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

export interface DirectoryPreferencesDialogProps {
  open: boolean
  onClose: () => void
}

export function DirectoryPreferencesDialog({
  open,
  onClose,
}: DirectoryPreferencesDialogProps) {
  return open ? <OpenDirectoryPreferencesDialog onClose={onClose} /> : null
}

function OpenDirectoryPreferencesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const id = useId()
  const platform = usePlatformServices()
  const { preferences, loading, error, refresh, mutate } =
    useDirectoryPreferences()
  const [activity, setActivity] = useState<'picking' | 'mutating' | null>(null)
  const [pickerFailed, setPickerFailed] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const lastFocused = useRef<HTMLElement | null>(null)
  const restoreAddFocus = useRef(false)
  const mounted = useRef(true)
  const closed = useRef(false)
  const generation = useRef(0)
  const operation = useRef<'picking' | 'mutating' | null>(null)
  const busy = loading || activity !== null
  const favoritesFull =
    preferences.favorites.length >= DIRECTORY_FAVORITES_LIMIT

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [])

  const focusContent = useCallback(
    () => contentRef.current?.focus({ preventScroll: true }),
    []
  )
  useLayoutEffect(() => {
    focusContent()
  }, [focusContent])
  useLayoutEffect(() => {
    // The native/Web picker owns focus while it is open. For manager actions,
    // a removed or disabled row must never leave keyboard focus on body.
    if (activity === 'picking') return
    const active = document.activeElement
    const lostFocusedControl =
      active === document.body &&
      lastFocused.current &&
      (!lastFocused.current.isConnected ||
        lastFocused.current.matches(':disabled'))
    if (!busy && restoreAddFocus.current) {
      restoreAddFocus.current = false
      if (addRef.current && !addRef.current.disabled)
        addRef.current.focus({ preventScroll: true })
      else focusContent()
    } else if (lostFocusedControl) focusContent()
  })

  const close = () => {
    if (closed.current || operation.current === 'picking') return
    closed.current = true
    onClose()
  }

  const runMutation = async (action: MutateDirectoryPreferencesRequest) => {
    if (operation.current || loading) return
    const current = generation.current
    // Move focus before the server can remove the focused row or disable it.
    focusContent()
    operation.current = 'mutating'
    setActivity('mutating')
    setPickerFailed(false)
    try {
      await mutate(action)
    } finally {
      if (mounted.current && generation.current === current) {
        operation.current = null
        setActivity(null)
      }
    }
  }

  const addFavorite = async () => {
    if (operation.current || loading || favoritesFull) return
    const current = generation.current
    operation.current = 'picking'
    setActivity('picking')
    setPickerFailed(false)
    try {
      // Call the platform directly: management browsing never records recent use.
      // The Web bus captures this still-enabled trigger synchronously.
      const path = await platform.pickSaveDir()
      if (!mounted.current || generation.current !== current) return
      if (path !== null) {
        operation.current = 'mutating'
        setActivity('mutating')
        focusContent()
        await mutate({ action: 'addFavorite', path })
      }
    } catch {
      if (mounted.current && generation.current === current)
        setPickerFailed(true)
    } finally {
      if (mounted.current && generation.current === current) {
        operation.current = null
        restoreAddFocus.current = true
        setActivity(null)
      }
    }
  }

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      return
    }
    const plain =
      !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    if (plain && event.repeat && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      return
    }
    if (plain && event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (open) return
        if (operation.current === 'picking') {
          details.cancel()
          return
        }
        close()
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={contentRef}
        onFocusCapture={(event) => {
          lastFocused.current = event.target as HTMLElement
        }}
        onKeyDown={keyDown}
        onKeyUp={(event) => event.stopPropagation()}
        className="flex h-[520px] max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[600px]"
        data-testid="directory-preferences-dialog"
      >
        <DialogHeader className="shrink-0 gap-2 border-b px-4 py-3">
          <DialogTitle className="text-sm">
            {t('directoryPreferences.title')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t('directoryPreferences.description')}
          </DialogDescription>
        </DialogHeader>
        <div
          ref={contentRef}
          tabIndex={-1}
          aria-busy={busy}
          data-testid="directory-preferences-content"
          className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 outline-none"
        >
          {(pickerFailed || error) && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/30 p-2 text-xs"
            >
              <p className="min-w-0 flex-1 text-destructive">
                {pickerFailed
                  ? t('directoryPreferences.pickerFailed')
                  : t(`directoryPreferences.errors.${error ?? 'unavailable'}`)}
              </p>
              {!pickerFailed && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    focusContent()
                    void refresh()
                  }}
                >
                  {t('directoryPreferences.retry')}
                </Button>
              )}
            </div>
          )}
          {loading && (
            <p role="status" className="text-xs text-muted-foreground">
              {t('directoryPreferences.loading')}
            </p>
          )}
          <section aria-labelledby={`${id}-favorites`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 id={`${id}-favorites`} className="text-xs font-medium">
                {t('directoryPreferences.favorites')}{' '}
                <span className="font-normal text-muted-foreground">
                  {preferences.favorites.length}/{DIRECTORY_FAVORITES_LIMIT}
                </span>
              </h3>
              <Button
                ref={addRef}
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || favoritesFull}
                onClick={() => void addFavorite()}
              >
                <FolderPlus />
                {t('directoryPreferences.addFavorite')}
              </Button>
            </div>
            {favoritesFull && (
              <p className="mb-2 text-xs text-muted-foreground">
                {t('directoryPreferences.limitHint', {
                  count: DIRECTORY_FAVORITES_LIMIT,
                })}
              </p>
            )}
            {preferences.favorites.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">
                {t('directoryPreferences.emptyFavorites')}
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {preferences.favorites.map((path) => (
                  <li key={path} className="flex items-start gap-2 px-2 py-2">
                    <Folder className="mt-1 size-4 shrink-0 text-muted-foreground" />
                    <span
                      dir="ltr"
                      className="min-w-0 flex-1 break-all text-xs whitespace-pre-wrap"
                    >
                      {path}
                    </span>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`${t('directoryPreferences.removeFavorite')} ${path}`}
                      title={t('directoryPreferences.removeFavorite')}
                      onClick={() =>
                        void runMutation({
                          action: 'removeFavorite',
                          paths: [path],
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby={`${id}-recent`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 id={`${id}-recent`} className="text-xs font-medium">
                {t('directoryPreferences.recent')}{' '}
                <span className="font-normal text-muted-foreground">
                  {preferences.recent.length}/{DIRECTORY_RECENT_LIMIT}
                </span>
              </h3>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || preferences.recent.length === 0}
                onClick={() => void runMutation({ action: 'clearRecent' })}
              >
                {t('directoryPreferences.clearRecent')}
              </Button>
            </div>
            {preferences.recent.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">
                {t('directoryPreferences.emptyRecent')}
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {preferences.recent.map((path) => {
                  const favorite = preferences.favorites.includes(path)
                  return (
                    <li key={path} className="flex items-start gap-2 px-2 py-2">
                      <Folder className="mt-1 size-4 shrink-0 text-muted-foreground" />
                      <span
                        dir="ltr"
                        className="min-w-0 flex-1 break-all text-xs whitespace-pre-wrap"
                      >
                        {path}
                      </span>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        disabled={busy || favorite || favoritesFull}
                        aria-label={`${t(favorite ? 'directoryPreferences.alreadyFavorite' : 'directoryPreferences.favoriteRecent')} ${path}`}
                        title={t(
                          favorite
                            ? 'directoryPreferences.alreadyFavorite'
                            : 'directoryPreferences.favoriteRecent'
                        )}
                        onClick={() =>
                          void runMutation({ action: 'addFavorite', path })
                        }
                      >
                        <Star
                          className={favorite ? 'fill-current' : undefined}
                        />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`${t('directoryPreferences.removeRecent')} ${path}`}
                        title={t('directoryPreferences.removeRecent')}
                        onClick={() =>
                          void runMutation({
                            action: 'removeRecent',
                            paths: [path],
                          })
                        }
                      >
                        <Trash2 />
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
        <DialogFooter className="shrink-0 border-t px-4 py-3">
          <DialogClose
            render={
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={activity === 'picking'}
              />
            }
          >
            {t('directoryPreferences.close')}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
