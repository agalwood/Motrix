import {
  type SidebarColor,
  sidebarColorSchema,
} from '@shared/schemas/sidebar-color'
import type { ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'

export function SidebarColorPicker({
  value,
  onChange,
  disabled,
  ...props
}: Omit<ComponentProps<'fieldset'>, 'onChange'> & {
  value: SidebarColor
  onChange: (color: SidebarColor) => void
}) {
  const { t } = useTranslation()
  return (
    <fieldset
      {...props}
      disabled={disabled}
      data-color={value}
      aria-label={t('settings.appearance.sidebarColor')}
      className="sidebar-color-picker flex shrink-0 flex-wrap gap-1 border-0 p-0"
    >
      {sidebarColorSchema.options.map((color) => (
        <label
          key={color}
          className="group/color relative flex w-8 cursor-pointer flex-col items-center gap-1.5"
        >
          <input
            type="radio"
            name="sidebar-color"
            value={color}
            checked={value === color}
            onChange={() => onChange(color)}
            className="peer absolute inset-0 z-10 size-full cursor-inherit opacity-0"
            aria-label={t(`settings.appearance.sidebarColors.${color}`)}
          />
          <span
            aria-hidden="true"
            data-color={color}
            className="sidebar-color-swatch"
          />
          <span
            aria-hidden="true"
            className="h-4 whitespace-nowrap text-[10px] leading-4 text-muted-foreground opacity-0 group-hover/color:opacity-100 peer-focus-visible:opacity-100"
          >
            {t(`settings.appearance.sidebarColors.${color}`)}
          </span>
        </label>
      ))}
    </fieldset>
  )
}
