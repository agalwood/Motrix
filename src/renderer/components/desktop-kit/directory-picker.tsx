import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { usePlatformServices } from '@renderer/platform/services'
import { Folder } from 'lucide-react'
import { useRef, useState } from 'react'
import {
  type FieldPath,
  type FieldValues,
  useFormContext,
  useWatch,
} from 'react-hook-form'
import { useTranslation } from 'react-i18next'

export interface DirectoryPickerProps<TFields extends FieldValues> {
  name: FieldPath<TFields>
  variant?: 'compact' | 'input'
  prefixLabel?: string
  placeholder?: string
  disabled?: boolean
}

export function DirectoryPicker<TFields extends FieldValues>({
  name,
  variant = 'input',
  prefixLabel,
  placeholder,
  disabled,
}: DirectoryPickerProps<TFields>) {
  const { t } = useTranslation()
  const { pickSaveDir } = usePlatformServices()
  const { setValue, control } = useFormContext<TFields>()
  const current = (useWatch({ control, name }) ?? '') as string
  const pickInFlight = useRef(false)
  const [isPicking, setIsPicking] = useState(false)
  const pickerDisabled = disabled || isPicking

  const handlePick = async () => {
    if (disabled || pickInFlight.current) return

    pickInFlight.current = true
    setIsPicking(true)
    try {
      const picked = await pickSaveDir(current || undefined)
      if (picked) {
        setValue(name, picked as never, {
          shouldValidate: true,
          shouldDirty: true,
        })
      }
    } finally {
      pickInFlight.current = false
      setIsPicking(false)
    }
  }

  if (variant === 'compact') {
    return (
      <button
        type="button"
        onClick={handlePick}
        aria-label={t('settings.common.changeDirectory')}
        title={current || undefined}
        disabled={pickerDisabled}
        className="group flex w-full items-center gap-2.5 rounded-md border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-ring hover:bg-accent/30 disabled:opacity-50"
      >
        {prefixLabel && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {prefixLabel}
          </span>
        )}
        {current ? (
          <span className="min-w-0 flex-1 truncate text-xs text-foreground [direction:rtl] [text-align:left]">
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
    )
  }

  return (
    <div className="flex gap-2">
      <Input
        value={current}
        placeholder={placeholder}
        readOnly
        disabled={pickerDisabled}
        className="flex-1 text-xs [direction:rtl] [text-align:left] h-8"
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
    </div>
  )
}
