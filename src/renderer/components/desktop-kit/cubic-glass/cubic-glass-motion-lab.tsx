import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@renderer/components/ui/popover'
import { Separator } from '@renderer/components/ui/separator'
import { Slider } from '@renderer/components/ui/slider'
import { Switch } from '@renderer/components/ui/switch'
import { RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_CUBIC_GLASS_EFFECTS } from './config'
import type { CubicGlassEffects } from './types'

export interface CubicGlassMotionLabProps {
  effects: CubicGlassEffects
  onEffectsChange: (effects: CubicGlassEffects) => void
}

interface EffectSwitchProps {
  checked: boolean
  disabled?: boolean
  label: string
  onCheckedChange: (checked: boolean) => void
}

type BooleanCubicGlassEffect = Exclude<
  keyof CubicGlassEffects,
  'horizontalSpeed'
>

function EffectSwitch({
  checked,
  disabled,
  label,
  onCheckedChange,
}: EffectSwitchProps) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-4 text-sm has-disabled:opacity-50">
      <span>{label}</span>
      <Switch
        size="sm"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

export function CubicGlassMotionLab({
  effects,
  onEffectsChange,
}: CubicGlassMotionLabProps) {
  const { t } = useTranslation()
  const horizontalSpeedId = useId()
  const updateEffect = (effect: BooleanCubicGlassEffect, checked: boolean) => {
    onEffectsChange({ ...effects, [effect]: checked })
  }

  return (
    <div className="app-no-drag absolute right-3 top-3 z-20">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={t('panel.downloads.empty.motion.open')}
              className="rounded-full bg-background/70 shadow-sm backdrop-blur-md"
            />
          }
        >
          <SlidersHorizontal aria-hidden className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={8}
          className="flex w-64 flex-col gap-3 p-3 motion-reduce:animate-none"
          initialFocus={false}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-0.5 text-left">
              <p className="text-sm font-medium">
                {t('panel.downloads.empty.motion.title')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('panel.downloads.empty.motion.description')}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('common.reset')}
              onClick={() =>
                onEffectsChange({ ...DEFAULT_CUBIC_GLASS_EFFECTS })
              }
            >
              <RotateCcw aria-hidden />
            </Button>
          </div>

          <EffectSwitch
            checked={effects.enabled}
            label={t('panel.downloads.empty.motion.enabled')}
            onCheckedChange={(checked) => updateEffect('enabled', checked)}
          />
          <Separator />
          <div className="flex flex-col gap-1">
            <EffectSwitch
              checked={effects.loadFade}
              disabled={!effects.enabled}
              label={t('panel.downloads.empty.motion.loadFade')}
              onCheckedChange={(checked) => updateEffect('loadFade', checked)}
            />
            <EffectSwitch
              checked={effects.breathing}
              disabled={!effects.enabled}
              label={t('panel.downloads.empty.motion.breathing')}
              onCheckedChange={(checked) => updateEffect('breathing', checked)}
            />
            <EffectSwitch
              checked={effects.pointerFollow}
              disabled={!effects.enabled}
              label={t('panel.downloads.empty.motion.pointerFollow')}
              onCheckedChange={(checked) =>
                updateEffect('pointerFollow', checked)
              }
            />
            <EffectSwitch
              checked={effects.positionConstraint}
              disabled={!effects.enabled || !effects.pointerFollow}
              label={t('panel.downloads.empty.motion.positionConstraint')}
              onCheckedChange={(checked) =>
                updateEffect('positionConstraint', checked)
              }
            />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={horizontalSpeedId}>
                {t('panel.downloads.empty.motion.horizontalSpeed')}
              </Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {effects.horizontalSpeed}%
              </span>
            </div>
            <Slider
              id={horizontalSpeedId}
              aria-label={t('panel.downloads.empty.motion.horizontalSpeed')}
              disabled={!effects.enabled || !effects.pointerFollow}
              min={0}
              max={100}
              step={1}
              value={effects.horizontalSpeed}
              onValueChange={(value) => {
                if (typeof value !== 'number') return
                onEffectsChange({ ...effects, horizontalSpeed: value })
              }}
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
