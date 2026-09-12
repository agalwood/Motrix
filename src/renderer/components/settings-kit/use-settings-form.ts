import { zodResolver } from '@hookform/resolvers/zod'
import { settingsValidationError } from '@renderer/lib/settings-validation'
import {
  type DefaultValues,
  type FieldValues,
  type Resolver,
  type SubmitHandler,
  type UseFormReturn,
  useForm,
} from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { z } from 'zod'

export function useSettingsForm<Values extends FieldValues>(
  schema: z.ZodType<Values, Values>,
  defaultValues: DefaultValues<Values>
) {
  const { t } = useTranslation()
  return useForm<Values>({
    defaultValues,
    resolver: zodResolver(schema, {
      error: settingsValidationError(t, schema),
    }) as Resolver<Values>,
    mode: 'onBlur',
  })
}

export function useSettingsSubmit<Values extends FieldValues>(
  form: UseFormReturn<Values>,
  save: SubmitHandler<Values>
) {
  const { t } = useTranslation()
  return form.handleSubmit(
    async (values, event) => {
      form.clearErrors('root.save')
      try {
        await save(values, event)
      } catch {
        form.setError('root.save', {
          type: 'server',
          message: t('settings.validation.saveFailed'),
        })
      }
    },
    () => form.clearErrors('root.save')
  )
}
