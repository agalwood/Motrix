import {
  CheckIcon,
  ChevronRightIcon,
  FolderIcon,
  ImportFileIcon,
} from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useDragDepth } from '@renderer/hooks/use-drag-depth'
import { recordRecentDirectory } from '@renderer/lib/directory-preferences'
import { cn } from '@renderer/lib/utils'
import { usePlatformServices } from '@renderer/platform/services'
import type { FilePickerOptions } from '@shared/schemas/file-picker'
import {
  type ComponentProps,
  type DragEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
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
  variant?: 'compact' | 'input' | 'file'
  prefixLabel?: string
  placeholder?: string
  disabled?: boolean
  inputProps?: ComponentProps<typeof Input>
  showHistory?: boolean
  recordRecent?: boolean
  onPickingChange?: (picking: boolean) => void
  allowFavoriteEditing?: boolean
  file?: Omit<FilePickerOptions, 'defaultPath'>
  browseLabel?: string
  onPicked?: (path: string) => void
  onPickError?: (error: unknown) => void
  allowDrop?: boolean
  fileIcon?: ReactNode
  fileIconClassName?: string
  fileHint?: string
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
  file,
  browseLabel,
  onPicked,
  onPickError,
  allowDrop = false,
  fileIcon,
  fileIconClassName,
  fileHint,
}: DirectoryPickerProps<TFields>) {
  const { t } = useTranslation()
  const { pickSaveDir, pickFile, getPathForFile, notify } =
    usePlatformServices()
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
  const pickerDisabled = disabled || isPicking || (!!file && !pickFile)

  const reportError = (error: unknown) => {
    if (onPickError) onPickError(error)
    else notify('error', 'directoryPicker.errors.unavailable')
  }
  const updatePath = (picked: string) => {
    setValue(name, picked as never, { shouldValidate: true, shouldDirty: true })
    onPicked?.(picked)
    if (recordRecent && !file) void recordRecentDirectory(picked)
  }
  const canDrop = allowDrop && file?.kind === 'open' && !!getPathForFile
  const { isDragging, dragHandlers } = useDragDepth<HTMLButtonElement>(
    (files) => {
      if (pickerDisabled || pickInFlight.current) return
      if (!canDrop || !getPathForFile) {
        reportError(new Error(t('directoryPicker.file.chooseOnServer')))
        return
      }
      try {
        if (files.length !== 1)
          throw new Error(t('directoryPicker.file.singleFile'))
        const selected = files[0]
        const extension = selected.name.split('.').pop()?.toLowerCase()
        if (
          file?.extensions?.length &&
          !file.extensions.some((ext) => ext.toLowerCase() === extension)
        )
          throw new Error(
            t('directoryPicker.file.wrongType', {
              extensions: file.extensions.join(', '),
            })
          )
        const picked = getPathForFile(selected)
        if (!picked) throw new Error(t('directoryPicker.file.pathUnavailable'))
        updatePath(picked)
      } catch (error) {
        reportError(error)
      }
    }
  )

  const handlePick = async () => {
    if (disabled || pickInFlight.current) return

    pickInFlight.current = true
    setIsPicking(true)
    onPickingChange?.(true)
    try {
      const picked = file
        ? await pickFile?.({ ...file, defaultPath: current || undefined })
        : allowFavoriteEditing
          ? await pickSaveDir(current || undefined)
          : await pickSaveDir(current || undefined, {
              allowFavoriteEditing: false,
            })
      if (!mounted.current) return
      if (picked) {
        updatePath(picked)
      }
    } catch (error) {
      if (mounted.current) {
        reportError(error)
      }
    } finally {
      pickInFlight.current = false
      if (mounted.current) {
        setIsPicking(false)
        onPickingChange?.(false)
      }
    }
  }

  const history =
    showHistory && !file ? (
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

  if (variant === 'file') {
    const divider = Math.max(
      current.lastIndexOf('/'),
      current.lastIndexOf('\\')
    )
    const filename = current.slice(divider + 1)
    const directory = current.slice(0, divider + 1)
    const save = file?.kind === 'save'
    return (
      <button
        type="button"
        id={inputProps?.id}
        aria-label={browseLabel ?? prefixLabel}
        aria-invalid={inputProps?.['aria-invalid']}
        aria-describedby={inputProps?.['aria-describedby']}
        title={current || undefined}
        disabled={pickerDisabled}
        onClick={handlePick}
        {...(allowDrop && !save
          ? {
              ...dragHandlers,
              onDrop: (event: DragEvent<HTMLButtonElement>) => {
                event.stopPropagation()
                dragHandlers.onDrop(event)
              },
            }
          : {})}
        className={cn(
          'group relative flex w-full min-w-0 gap-2.5 rounded-xl border bg-card p-3 text-start outline-none transition-colors duration-150 hover:border-foreground/25 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none',
          save ? 'items-center' : 'min-h-36 flex-col',
          isDragging &&
            canDrop &&
            !pickerDisabled &&
            'border-foreground/50 bg-muted ring-2 ring-ring/20',
          inputProps?.['aria-invalid'] && 'border-destructive'
        )}
      >
        <span className={cn('flex items-center gap-2.5', save && 'shrink-0')}>
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground [&_svg]:size-5',
              fileIconClassName
            )}
          >
            {fileIcon ?? <ImportFileIcon aria-hidden />}
          </span>
          {!save && (
            <span className="text-xs font-medium text-muted-foreground">
              {prefixLabel}
            </span>
          )}
          {!save && current && (
            <CheckIcon aria-hidden className="ms-auto size-4 text-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          {save && (
            <span className="block text-xs font-medium text-muted-foreground">
              {prefixLabel}
            </span>
          )}
          <span
            dir={current ? 'ltr' : undefined}
            className="block truncate text-sm font-medium"
          >
            {filename || placeholder || t('directoryPicker.file.choose')}
          </span>
          <span
            dir={current ? 'ltr' : undefined}
            className="block truncate text-xs leading-5 text-muted-foreground"
          >
            {directory ||
              fileHint ||
              t(
                canDrop
                  ? 'directoryPicker.file.dropHint'
                  : 'directoryPicker.file.browseHint'
              )}
          </span>
        </span>
        {save ? (
          <ChevronRightIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
        ) : (
          <span className="text-xs font-medium text-foreground">
            {t(
              current
                ? 'directoryPicker.file.change'
                : canDrop
                  ? 'directoryPicker.file.dropHint'
                  : 'directoryPicker.file.choose'
            )}
          </span>
        )}
      </button>
    )
  }

  if (variant === 'compact') {
    return (
      <div className="flex min-w-0 gap-2">
        <button
          type="button"
          onClick={handlePick}
          aria-label={browseLabel ?? t('settings.common.changeDirectory')}
          title={current || undefined}
          disabled={pickerDisabled}
          className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-md border border-border bg-background px-3 py-2 text-start text-sm transition-colors hover:border-ring hover:bg-accent/30 disabled:opacity-50"
        >
          {prefixLabel && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {prefixLabel}
            </span>
          )}
          {current ? (
            <span
              dir="ltr"
              className="min-w-0 flex-1 truncate text-start text-xs text-foreground"
            >
              {current}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs italic text-muted-foreground">
              {placeholder ?? t('settings.common.directoryEmpty')}
            </span>
          )}
          <FolderIcon
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
        className="h-8 min-w-0 flex-1 text-start text-xs"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handlePick}
        disabled={pickerDisabled}
        aria-label={browseLabel}
      >
        <FolderIcon className="me-1 h-3 w-3" />
        {t('settings.common.browse')}
      </Button>
      {history}
    </div>
  )
}
