import {
  CheckIcon,
  DirectoryPreferencesIcon,
  HistoryIcon,
} from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { DirectoryPreferencesDialog } from '@renderer/features/directory-preferences/directory-preferences-dialog'
import {
  useDirectoryPreferences,
  useServerDirectoryLocations,
} from '@renderer/lib/directory-preferences'
import { usePlatformServices } from '@renderer/platform/services'
import {
  type KeyboardEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

interface DirectoryHistoryMenuProps {
  currentPath: string
  disabled?: boolean
  onSelect: (path: string) => void
}

function containSubmitShortcut(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    event.stopPropagation()
  }
}

export function DirectoryHistoryMenu({
  currentPath,
  disabled,
  onSelect,
}: DirectoryHistoryMenuProps) {
  const { t } = useTranslation()
  const { kind } = usePlatformServices()
  const [open, setOpen] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const openingManager = useRef(false)

  const openManager = () => {
    openingManager.current = true
    setOpen(false)
  }

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          if (next) openingManager.current = false
          setOpen(next)
        }}
        onOpenChangeComplete={(next) => {
          if (!next && openingManager.current) {
            // Wait for the menu focus trap to close, then let the manager
            // capture the live trigger instead of a removed menu item.
            trigger.current?.focus()
            setManagerOpen(true)
          }
        }}
      >
        <DropdownMenuTrigger
          ref={trigger}
          disabled={disabled}
          onKeyDownCapture={containSubmitShortcut}
          render={<Button type="button" variant="outline" size="icon-sm" />}
          aria-label={t('directoryPreferences.history')}
          title={t('directoryPreferences.history')}
          className="h-auto min-h-8 shrink-0"
        >
          <HistoryIcon aria-hidden="true" className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          ref={popup}
          align="end"
          className="w-96 max-w-[calc(100vw-2rem)]"
          aria-label={t('directoryPreferences.history')}
          finalFocus={() => !openingManager.current}
          onKeyDownCapture={containSubmitShortcut}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {open && (
            <>
              {kind === 'web' ? (
                <ServerHistoryItems
                  currentPath={currentPath}
                  onSelect={onSelect}
                  popup={popup}
                />
              ) : (
                <AppHistoryItems
                  currentPath={currentPath}
                  onSelect={onSelect}
                  popup={popup}
                />
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={openManager}>
                <DirectoryPreferencesIcon aria-hidden="true" />
                {t('directoryPreferences.manage')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DirectoryPreferencesDialog
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
      />
    </>
  )
}

interface HistoryItemsProps {
  currentPath: string
  onSelect: (path: string) => void
  popup: RefObject<HTMLDivElement | null>
}

function AppHistoryItems(props: HistoryItemsProps) {
  const { preferences, loading, error, refresh } = useDirectoryPreferences()
  return (
    <HistoryItems
      {...props}
      favorites={preferences.favorites}
      recent={preferences.recent}
      loading={loading}
      error={error}
      refresh={refresh}
    />
  )
}

function ServerHistoryItems(props: HistoryItemsProps) {
  const { locations, loading, error, refresh } = useServerDirectoryLocations()
  return (
    <HistoryItems
      {...props}
      favorites={locations?.favorites.map((entry) => entry.path) ?? []}
      recent={locations?.recent.map((entry) => entry.path) ?? []}
      loading={loading}
      error={error}
      refresh={refresh}
    />
  )
}

function HistoryItems({
  currentPath,
  onSelect,
  popup,
  favorites,
  recent,
  loading,
  error,
  refresh,
}: HistoryItemsProps & {
  favorites: string[]
  recent: string[]
  loading: boolean
  error: string | null
  refresh: () => unknown
}) {
  const { t } = useTranslation()
  // An event can remove the focused history entry while this menu is open.
  // Keep the next key inside the menu, including the parent submit shortcut.
  useLayoutEffect(() => {
    if (document.activeElement === document.body) popup.current?.focus()
  })
  const groups = [
    { key: 'favorites', paths: favorites },
    { key: 'recent', paths: recent },
  ] as const

  return (
    <>
      {groups.map(({ key, paths }) =>
        paths.length > 0 ? (
          <DropdownMenuGroup key={key}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t(`directoryPreferences.${key}`)}
            </DropdownMenuLabel>
            {paths.map((path) => (
              <DropdownMenuItem
                key={path}
                onClick={() => onSelect(path)}
                label={path}
                title={path}
                aria-current={path === currentPath ? 'true' : undefined}
                className="items-start text-xs"
              >
                <span className="size-4 shrink-0">
                  {path === currentPath && <CheckIcon aria-hidden="true" />}
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-all">
                  {path}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ) : null
      )}
      {loading && (
        <div role="status" className="px-2 py-2 text-xs text-muted-foreground">
          {t('directoryPreferences.loading')}
        </div>
      )}
      {error && (
        <>
          <div role="alert" className="px-2 py-2 text-xs text-destructive">
            {t(`directoryPreferences.errors.${error}`)}
          </div>
          <DropdownMenuItem closeOnClick={false} onClick={() => void refresh()}>
            {t('directoryPreferences.retry')}
          </DropdownMenuItem>
        </>
      )}
      {!loading && !error && !favorites.length && !recent.length && (
        <div className="px-2 py-2 text-xs text-muted-foreground">
          {t('directoryPreferences.emptyHistory')}
        </div>
      )}
    </>
  )
}
