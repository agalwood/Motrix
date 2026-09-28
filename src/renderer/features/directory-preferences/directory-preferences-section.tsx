import {
  ChevronRightIcon,
  FavoriteIcon,
  FolderAddIcon,
  FolderIcon,
  RemoveIcon,
} from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { usePlatformServices } from '@renderer/platform/services'
import {
  DIRECTORY_FAVORITES_LIMIT,
  DIRECTORY_RECENT_LIMIT,
  type DirectoryPreferences,
} from '@shared/schemas/directory-preferences'
import type { GeneralSettingsErrorCode } from '@shared/schemas/general-settings'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface DirectoryPreferencesSectionProps {
  preferences: DirectoryPreferences
  onChange: (preferences: DirectoryPreferences) => void
  disabled?: boolean
  onPickingChange?: (picking: boolean) => void
}

export function DirectoryPreferencesStatus({
  loading,
  error,
  disabled,
  onRetry,
}: {
  loading: boolean
  error: GeneralSettingsErrorCode | null
  disabled?: boolean
  onRetry: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/30 p-2 text-xs"
        >
          <p className="min-w-0 flex-1 text-destructive">
            {t(`directoryPreferences.errors.${error}`)}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || loading}
            onClick={onRetry}
          >
            {t('directoryPreferences.retry')}
          </Button>
        </div>
      )}
      {loading && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('directoryPreferences.loading')}
        </p>
      )}
    </>
  )
}

export function DirectoryPreferencesSection({
  preferences,
  onChange,
  disabled,
  onPickingChange,
}: DirectoryPreferencesSectionProps) {
  const { t } = useTranslation()
  const platform = usePlatformServices()
  const [favoritesOpen, setFavoritesOpen] = useState(true)
  const [recentOpen, setRecentOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [pickerFailed, setPickerFailed] = useState(false)
  const content = useRef<HTMLDivElement>(null)
  const add = useRef<HTMLButtonElement>(null)
  const pickInFlight = useRef(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const restoreAddFocus = useRef(false)
  const busy = disabled || picking
  const full = preferences.favorites.length >= DIRECTORY_FAVORITES_LIMIT
  const latest = useRef(preferences)
  latest.current = preferences

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [])
  useLayoutEffect(() => {
    if (!picking && restoreAddFocus.current) {
      restoreAddFocus.current = false
      if (add.current && !add.current.disabled)
        add.current.focus({ preventScroll: true })
      else content.current?.focus({ preventScroll: true })
    }
  }, [picking])

  const change = (next: DirectoryPreferences) => {
    content.current?.focus({ preventScroll: true })
    onChange(next)
  }
  const addFavorite = async () => {
    if (disabled || pickInFlight.current || full) return
    const current = generation.current
    pickInFlight.current = true
    setPicking(true)
    setPickerFailed(false)
    onPickingChange?.(true)
    try {
      const path = await platform.pickSaveDir(undefined, {
        allowFavoriteEditing: false,
      })
      if (!mounted.current || current !== generation.current) return
      if (path !== null && !latest.current.favorites.includes(path)) {
        change({
          ...latest.current,
          favorites: [...latest.current.favorites, path],
        })
        setFavoritesOpen(true)
      }
    } catch {
      if (mounted.current && current === generation.current)
        setPickerFailed(true)
    } finally {
      if (mounted.current && current === generation.current) {
        pickInFlight.current = false
        restoreAddFocus.current = true
        setPicking(false)
        onPickingChange?.(false)
      }
    }
  }

  const rows = (paths: string[], recent: boolean) =>
    paths.length === 0 ? (
      <p className="px-2 py-2 text-xs text-muted-foreground">
        {t(
          recent
            ? 'directoryPreferences.emptyRecent'
            : 'directoryPreferences.emptyFavorites'
        )}
      </p>
    ) : (
      <ul className="divide-y rounded-md border">
        {paths.map((path) => {
          const favorite = preferences.favorites.includes(path)
          return (
            <li key={path} className="flex items-center gap-2 px-2 py-1">
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              <span
                dir="ltr"
                title={path}
                className="min-w-0 flex-1 truncate text-xs whitespace-pre"
              >
                {path}
              </span>
              {recent && (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy || favorite || full}
                  aria-label={`${t(favorite ? 'directoryPreferences.alreadyFavorite' : 'directoryPreferences.favoriteRecent')} ${path}`}
                  title={t(
                    favorite
                      ? 'directoryPreferences.alreadyFavorite'
                      : 'directoryPreferences.favoriteRecent'
                  )}
                  onClick={() =>
                    change({
                      ...preferences,
                      favorites: [...preferences.favorites, path],
                    })
                  }
                >
                  <FavoriteIcon
                    className={favorite ? 'fill-current' : undefined}
                  />
                </Button>
              )}
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={busy}
                aria-label={`${t(recent ? 'directoryPreferences.removeRecent' : 'directoryPreferences.removeFavorite')} ${path}`}
                title={t(
                  recent
                    ? 'directoryPreferences.removeRecent'
                    : 'directoryPreferences.removeFavorite'
                )}
                onClick={() =>
                  change(
                    recent
                      ? {
                          ...preferences,
                          recent: preferences.recent.filter(
                            (entry) => entry !== path
                          ),
                        }
                      : {
                          ...preferences,
                          favorites: preferences.favorites.filter(
                            (entry) => entry !== path
                          ),
                        }
                  )
                }
              >
                <RemoveIcon />
              </Button>
            </li>
          )
        })}
      </ul>
    )

  return (
    <div
      ref={content}
      tabIndex={-1}
      className="space-y-3 outline-none"
      data-testid="directory-preferences-section"
    >
      {pickerFailed && (
        <p role="alert" className="text-xs text-destructive">
          {t('directoryPreferences.pickerFailed')}
        </p>
      )}
      <Collapsible open={favoritesOpen} onOpenChange={setFavoritesOpen}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <CollapsibleTrigger
            disabled={busy}
            className="flex min-w-0 items-center gap-1 text-xs font-medium"
          >
            <ChevronRightIcon
              className={`size-3.5 shrink-0 ${favoritesOpen ? 'rotate-90' : ''}`}
            />
            {t('directoryPreferences.favorites')}
            <span className="font-normal text-muted-foreground">
              {preferences.favorites.length}/{DIRECTORY_FAVORITES_LIMIT}
            </span>
          </CollapsibleTrigger>
          <Button
            ref={add}
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || full}
            onClick={() => void addFavorite()}
          >
            <FolderAddIcon />
            {t('directoryPreferences.addFavorite')}
          </Button>
        </div>
        <CollapsibleContent>
          {full && (
            <p className="mb-2 text-xs text-muted-foreground">
              {t('directoryPreferences.limitHint', {
                count: DIRECTORY_FAVORITES_LIMIT,
              })}
            </p>
          )}
          {rows(preferences.favorites, false)}
        </CollapsibleContent>
      </Collapsible>
      <Collapsible open={recentOpen} onOpenChange={setRecentOpen}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <CollapsibleTrigger
            disabled={busy}
            className="flex min-w-0 items-center gap-1 text-xs font-medium"
          >
            <ChevronRightIcon
              className={`size-3.5 shrink-0 ${recentOpen ? 'rotate-90' : ''}`}
            />
            {t('directoryPreferences.recent')}
            <span className="font-normal text-muted-foreground">
              {preferences.recent.length}/{DIRECTORY_RECENT_LIMIT}
            </span>
          </CollapsibleTrigger>
          {recentOpen && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || preferences.recent.length === 0}
              onClick={() => change({ ...preferences, recent: [] })}
            >
              {t('directoryPreferences.clearRecent')}
            </Button>
          )}
        </div>
        <CollapsibleContent>
          {rows(preferences.recent, true)}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
