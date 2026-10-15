import type * as React from 'react'
import { useState } from 'react'
import type { FieldValues, UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Form } from '@/components/ui/form'

export function SettingsTabForm<T extends FieldValues>({
  form,
  onSubmit,
  children,
}: {
  form: UseFormReturn<T>
  onSubmit: (values: T) => Promise<void>
  children: React.ReactNode
}): React.ReactElement {
  const { t } = useTranslation()
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { isDirty, isSubmitting } = form.formState

  const submit = async (values: T): Promise<void> => {
    setError(null)
    setSaved(false)
    try {
      await onSubmit(values)
      form.reset(values)
      setSaved(true)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="space-y-5">
        {children}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {saved && !isDirty && error === null && (
            <span className="text-xs text-green-600 dark:text-green-400">
              {t('options.common.saved')}
            </span>
          )}
          {error !== null && (
            <span className="text-xs text-destructive">{error}</span>
          )}
          <div className="ms-auto flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!isDirty || isSubmitting}
              onClick={() => {
                form.reset()
                setError(null)
                setSaved(false)
              }}
            >
              {t('options.common.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!isDirty || isSubmitting}>
              {isSubmitting
                ? t('options.common.saving')
                : t('options.common.apply')}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  )
}
