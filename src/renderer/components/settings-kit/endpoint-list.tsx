import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { X } from 'lucide-react'
import { useState } from 'react'
import { Controller, useFieldArray, useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { z } from 'zod/v4'

export interface EndpointListProps {
  name: string
  maxItems?: number
  itemSchema?: z.ZodSchema<string>
  placeholder?: string
  i18nKeys: {
    addButton: string
    empty: string
  }
}

export function EndpointList({
  name,
  maxItems,
  itemSchema,
  placeholder,
  i18nKeys,
}: EndpointListProps) {
  const { t } = useTranslation()
  const { control } = useFormContext()
  const { fields, append, remove } = useFieldArray({ control, name })
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)

  const canAdd = !maxItems || fields.length < maxItems

  const handleAdd = () => {
    if (itemSchema) {
      const r = itemSchema.safeParse(draft)
      if (!r.success) {
        setDraftError(r.error.issues[0]?.message ?? 'invalid')
        return
      }
    } else if (!draft) {
      setDraftError('required')
      return
    }
    append(draft as never)
    setDraft('')
    setDraftError(null)
  }

  return (
    <div className="space-y-2">
      {fields.length === 0 && (
        <p className="text-xs text-muted-foreground">{t(i18nKeys.empty)}</p>
      )}

      {fields.map((f, i) => (
        <div key={f.id} className="flex items-center gap-2">
          <Controller
            control={control}
            name={`${name}.${i}`}
            render={({ field, fieldState }) => (
              <>
                <Input className="flex-1" {...field} />
                {fieldState.error && (
                  <span className="text-xs text-destructive">
                    {fieldState.error.message}
                  </span>
                )}
              </>
            )}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('common.remove')}
            onClick={() => remove(i)}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}

      {canAdd && (
        <div className="flex items-start gap-2">
          <div className="flex-1 space-y-1">
            <Input
              className="h-8"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setDraftError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAdd()
                }
              }}
              placeholder={placeholder}
            />
            {draftError && (
              <p className="text-xs text-destructive">{draftError}</p>
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
