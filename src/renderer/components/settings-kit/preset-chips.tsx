import { Button } from '@renderer/components/ui/button'
import { useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

export interface PresetOption<T> {
  labelKey?: string
  label?: string
  value: T
}

export interface PresetChipsProps<T> {
  name: string
  options: PresetOption<T>[]
}

export function PresetChips<T>({ name, options }: PresetChipsProps<T>) {
  const { setValue, control } = useFormContext()
  const current = useWatch({ control, name })
  const { t } = useTranslation()

  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt, i) => {
        const active = current === opt.value
        const label = opt.labelKey ? t(opt.labelKey) : opt.label
        return (
          <Button
            // biome-ignore lint/suspicious/noArrayIndexKey: option list is stable per render
            key={i}
            type="button"
            size="sm"
            variant={active ? 'default' : 'outline'}
            className="h-6 px-2 text-xs"
            onClick={() => setValue(name, opt.value, { shouldDirty: true })}
          >
            {label}
          </Button>
        )
      })}
    </div>
  )
}
