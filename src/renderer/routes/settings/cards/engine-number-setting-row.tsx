import { PresetChips } from '@renderer/components/settings-kit/preset-chips'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  type DownloadsFields,
  ENGINE_DEFAULTS,
  type EngineFields,
} from './downloads-form'

export interface EngineNumberSettingRowProps {
  form: UseFormReturn<DownloadsFields>
  name: keyof EngineFields
  labelKey: string
  descKey: string
  bounds: { min?: number; max?: number; step?: number; scale?: number }
  presets?: { label: string; value: number }[]
}

// Compact numeric setting row shared by the performance and engine sections.
// `bounds.scale` is the stored-per-displayed multiplier (for example MB).
export function EngineNumberSettingRow({
  form,
  name,
  labelKey,
  descKey,
  bounds,
  presets,
}: EngineNumberSettingRowProps) {
  const { t } = useTranslation()
  const scale = bounds.scale ?? 1
  const scaledPresets = presets?.map((preset) => ({
    ...preset,
    value: preset.value * scale,
  }))

  return (
    <FormField
      control={form.control}
      name={`engine.${name}` as never}
      render={({ field }) => {
        const stored = field.value as number
        const displayed = scale === 1 ? stored : Math.round(stored / scale)
        return (
          <FormItem className="space-y-2">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <FormLabel>{t(labelKey)}</FormLabel>
                <FormDescription className="text-xs">
                  {t(descKey)}
                </FormDescription>
              </div>
              <FormControl>
                <Input
                  type="number"
                  min={bounds.min}
                  max={bounds.max}
                  step={bounds.step}
                  className="w-30 h-8"
                  value={displayed}
                  onChange={(event) => {
                    const value = Number.parseInt(event.target.value, 10)
                    field.onChange(
                      Number.isFinite(value)
                        ? value * scale
                        : (ENGINE_DEFAULTS as never)[name]
                    )
                  }}
                />
              </FormControl>
            </div>
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
