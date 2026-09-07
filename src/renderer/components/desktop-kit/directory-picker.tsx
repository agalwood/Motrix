import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { recordRecentDirectory } from '@renderer/lib/directory-preferences'
import { usePlatformServices } from '@renderer/platform/services'
import { Folder } from 'lucide-react'
import { type ComponentProps, useEffect, useRef, useState } from 'react'
import {
  type FieldPath,
  type FieldValues,
  useFormContext,
  useWatch,
} from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { DirectoryHistoryMenu } from './directory-history-menu'

export interface DirectoryPickerProps<TFields extends FieldValues> {
  name: FieldPath<TFields>
  variant?: 'compact' | 'input'
  prefixLabel?: string
  placeholder?: string
  disabled?: boolean
  inputProps?: ComponentProps<typeof Input>
  showHistory?: boolean
  recordRecent?: boolean
  onPickingChange?: (picking: boolean) => void
  allowFavoriteEditing?: boolean
}

export function DirectoryPicker<TFields extends FieldValues>({
  name,
  variant = 'input',
  prefixLabel,
  placeholder,
  disabled,
  inputProps,
  showHistory = false,
  recordRecent = true,
  onPickingChange,
  allowFavoriteEditing = true,
}: DirectoryPickerProps<TFields>) {
  const { t } = useTranslation()
  const { pickSaveDir } = usePlatformServices()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const { setValue, control } = useFormContext<TFields>()
  const current = (useWatch({ control, name }) ?? '') as string
  const pickInFlight = useRef(false)
  const [isPicking, setIsPicking] = useState(false)
  const pickerDisabled = disabled || isPicking

  const handlePick = async () => {
    if (disabled || pickInFlight.current) return

    pickInFlight.current = true
    setIsPicking(true)
    onPickingChange?.(true)
    try {
      const picked = allowFavoriteEditing
        ? await pickSaveDir(current || undefined)
        : await pickSaveDir(current || undefined, {
            allowFavoriteEditing: false,
          })
      if (!mounted.current) return
      if (picked) {
        setValue(name, picked as never, {
          shouldValidate: true,
          shouldDirty: true,
        })
        if (recordRecent) void recordRecentDirectory(picked)
      }
    } finally {
      pickInFlight.current = false
      if (mounted.current) {
        setIsPicking(false)
        onPickingChange?.(false)
      }
    }
  }

  const history = showHistory ? (
    <DirectoryHistoryMenu
      currentPath={current}
      disabled={pickerDisabled}
      onSelect={(path) => {
        setValue(name, path as never, {
          shouldValidate: true,
          shouldDirty: true,
        })
      }}
    />
  ) : null

  if (variant === 'compact') {
    return (
      <div className="flex min-w-0 gap-2">
        <button
          type="button"
          onClick={handlePick}
          aria-label={t('settings.common.changeDirectory')}
          title={current || undefined}
          disabled={pickerDisabled}
          className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-md border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-ring hover:bg-accent/30 disabled:opacity-50"
        >
          {prefixLabel && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {prefixLabel}
            </span>
          )}
          {current ? (
            <span
              dir="ltr"
              className="min-w-0 flex-1 truncate text-left text-xs text-foreground"
            >
              {current}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs italic text-muted-foreground">
              {placeholder ?? t('settings.common.directoryEmpty')}
            </span>
          )}
          <Folder
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </button>
        {history}
      </div>
    )
  }

  return (
    <div className="flex gap-2">
      <Input
        {...inputProps}
        name={name}
        value={current}
        dir="ltr"
        title={current || undefined}
        placeholder={placeholder}
        readOnly
        disabled={pickerDisabled}
        className="h-8 min-w-0 flex-1 text-left text-xs"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handlePick}
        disabled={pickerDisabled}
      >
        <Folder className="mr-1 h-3 w-3" />
        {t('settings.common.browse')}
      </Button>
      {history}
    </div>
  )
}
