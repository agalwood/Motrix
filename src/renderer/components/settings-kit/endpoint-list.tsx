import { Button } from '@renderer/components/ui/button'
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import { settingsValidationError } from '@renderer/lib/settings-validation'
import { X } from 'lucide-react'
import { useId, useState } from 'react'
import { useController, useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { z } from 'zod'

export interface EndpointListProps {
  name: string
  maxItems?: number
  itemSchema?: z.ZodType<string>
  placeholder?: string
  i18nKeys: { addButton: string; empty: string }
}

export function EndpointList({
  name,
  maxItems,
  itemSchema,
  placeholder,
  i18nKeys,
}: EndpointListProps) {
  const { t } = useTranslation()
  const { control, setValue } = useFormContext()
  const { field } = useController({ control, name })
  const entries: string[] = field.value ?? []
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
  const draftErrorId = useId()
  const canAdd = maxItems === undefined || entries.length < maxItems
  const update = (values: string[]) =>
    setValue(name, values, { shouldDirty: true, shouldValidate: true })
  const handleAdd = () => {
    if (!draft.trim()) {
      setDraftError(t('settings.validation.required'))
      return
    }
    if (itemSchema) {
      const result = itemSchema.safeParse(draft, {
        error: settingsValidationError(t, itemSchema),
      })
      if (!result.success) {
        setDraftError(
          result.error.issues[0]?.message ?? t('settings.validation.invalid')
        )
        return
      }
    }
    if (!canAdd) return
    update([...entries, draft])
    setDraft('')
    setDraftError(null)
  }

  return (
    <div className="space-y-2">
      {entries.length === 0 && (
        <p className="text-xs text-muted-foreground">{t(i18nKeys.empty)}</p>
      )}
      {entries.map((_, index) => (
        <FormField
          // Entries are controlled values; their field paths follow array indices after removal.
          // biome-ignore lint/suspicious/noArrayIndexKey: the field path is the row identity
          key={index}
          control={control}
          name={`${name}.${index}`}
          render={({ field: entry }) => (
            <FormItem className="flex flex-wrap items-start gap-2">
              <FormControl>
                <Input
                  {...entry}
                  className="min-w-0 flex-1"
                  aria-label={t('settings.validation.address', {
                    number: index + 1,
                  })}
                />
              </FormControl>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('common.remove')}
                onClick={() =>
                  update(entries.filter((_, position) => position !== index))
                }
              >
                <X className="h-3 w-3" />
              </Button>
              <FormMessage className="basis-full text-xs" />
            </FormItem>
          )}
        />
      ))}
      {canAdd && (
        <div className="flex items-start gap-2">
          <div className="flex-1 space-y-1">
            <Input
              className="h-8"
              value={draft}
              aria-label={t('settings.validation.addressDraft')}
              aria-invalid={Boolean(draftError)}
              aria-describedby={draftError ? draftErrorId : undefined}
              onChange={(event) => {
                setDraft(event.target.value)
                setDraftError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  handleAdd()
                }
              }}
              placeholder={placeholder}
            />
            {draftError && (
              <p
                id={draftErrorId}
                role="alert"
                className="text-xs text-destructive"
              >
                {draftError}
              </p>
            )}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleAdd}>
            {t(i18nKeys.addButton)}
          </Button>
        </div>
      )}
    </div>
  )
}
