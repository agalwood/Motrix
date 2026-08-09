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
      onClick={onClick}
      className={cn(
        'group flex h-full min-h-33 select-none flex-col items-start px-5 py-3 text-left min-[914px]:min-h-[170px] min-[914px]:px-6 min-[914px]:py-4',
        className
      )}
    >
      <div className="flex max-h-18 flex-1 items-center justify-center transition-[filter] group-active:grayscale-50 min-[914px]:max-h-none [&_img]:max-h-16 [&_img]:w-auto min-[914px]:[&_img]:max-h-none">
        {Icon}
      </div>
      <div className="min-h-14 pt-3 min-[914px]:min-h-[90px] min-[914px]:pt-6">
        <div className="text-sm font-semibold text-foreground">
          {t(labelKey)}
        </div>
        <div className="line-clamp-2 pt-1.5 text-xs text-gray-400 min-[914px]:pt-2">
          {t(descKey)}
        </div>
      </div>
    </button>
  )
}
