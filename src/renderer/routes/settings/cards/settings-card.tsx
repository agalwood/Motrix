import { cn } from '@renderer/lib/utils'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

interface SettingsCardProps {
  icon: ReactElement
  labelKey: string
  descKey: string
  onClick: () => void
  className?: string
}

export function SettingsCard({
  icon: Icon,
  labelKey,
  descKey,
  onClick,
  className,
}: SettingsCardProps) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      data-slot="settings-card"
      onClick={onClick}
      className={cn(
        'group flex min-w-0 min-h-20 select-none items-center gap-3 px-2 py-3 text-start @min-[400px]/settings:min-h-33 @min-[400px]/settings:flex-col @min-[400px]/settings:items-start @min-[400px]/settings:gap-0 @min-[400px]/settings:px-5 @min-[600px]/settings:min-h-[170px] @min-[600px]/settings:px-6 @min-[600px]/settings:py-4',
        className
      )}
    >
      <div className="flex size-10 shrink-0 items-center justify-center transition-[filter] group-active:grayscale-50 @min-[400px]/settings:h-auto @min-[400px]/settings:max-h-18 @min-[400px]/settings:w-auto @min-[400px]/settings:flex-1 @min-[600px]/settings:max-h-none [&_img]:max-h-full [&_img]:max-w-full [&_img]:w-auto @min-[400px]/settings:[&_img]:max-h-16 @min-[600px]/settings:[&_img]:max-h-none">
        {Icon}
      </div>
      <div className="min-w-0 flex-1 @min-[400px]/settings:min-h-14 @min-[400px]/settings:flex-none @min-[400px]/settings:pt-3 @min-[400px]/settings:ps-1 @min-[600px]/settings:min-h-22.5 @min-[600px]/settings:pt-6">
        <div className="break-words text-sm font-semibold text-foreground">
          {t(labelKey)}
        </div>
        <div className="line-clamp-2 break-words pt-1.5 text-xs text-gray-400 @min-[600px]/settings:pt-2">
          {t(descKey)}
        </div>
      </div>
    </button>
  )
}
