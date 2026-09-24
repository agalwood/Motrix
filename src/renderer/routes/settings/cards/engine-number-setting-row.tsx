import { PresetChips } from '@renderer/components/settings-kit/preset-chips'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  type DownloadsFields,
  type EngineNumberField,
  getEngineNumberRules,
} from './downloads-form'

export interface EngineNumberSettingRowProps {
  form: UseFormReturn<DownloadsFields>
  name: EngineNumberField
  labelKey: string
  descKey: string
  presets?: { label: string; value: number }[]
}

// Compact numeric setting row shared by the performance and engine sections.
// Bounds and displayed units come from the shared validation rules.
export function EngineNumberSettingRow({
  form,
  name,
  labelKey,
  descKey,
  presets,
}: EngineNumberSettingRowProps) {
  const { t } = useTranslation()
  const { min, max, scale, hasUpperBound } = getEngineNumberRules(name)
  const scaledPresets = presets?.map((preset) => ({
    ...preset,
    value: preset.value * scale,
  }))

  return (
    <FormField
      control={form.control}
      name={`engine.${name}`}
      render={({ field }) => {
        const displayed = Number.isFinite(field.value)
          ? field.value / scale
          : ''
        return (
          <FormItem className="space-y-2">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <FormLabel>{t(labelKey)}</FormLabel>
                <FormDescription className="text-xs">
                  {t(descKey)}{' '}
                  {t(
                    hasUpperBound
                      ? 'settings.validation.rangeHint'
                      : 'settings.validation.minimum',
                    { min, max }
                  )}
                </FormDescription>
              </div>
              <FormControl>
                <Input
                  {...field}
                  type="number"
                  min={min}
                  max={max}
                  step={scale === 1 ? 1 : 'any'}
                  className="w-30 h-8"
                  value={displayed}
                  onChange={(event) => {
                    field.onChange(event.target.valueAsNumber * scale)
                  }}
                />
              </FormControl>
            </div>
            <FormMessage className="text-xs" />
            {scaledPresets && (
              <PresetChips
                name={`engine.${name}`}
                options={scaledPresets as never}
              />
            )}
          </FormItem>
        )
      }}
    />
  )
}
