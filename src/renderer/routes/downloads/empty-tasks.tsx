import {
  type CubicGlassEffects,
  CubicGlassGradient,
  DEFAULT_CUBIC_GLASS_EFFECTS,
} from '@renderer/components/desktop-kit/cubic-glass'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DownloadsTab } from './filter'

type CubicGlassMotionLabModule =
  typeof import('@renderer/components/desktop-kit/cubic-glass/cubic-glass-motion-lab')

const cubicGlassMotionLabModule: CubicGlassMotionLabModule | null = import.meta
  .env.DEV
  ? await import(
      '@renderer/components/desktop-kit/cubic-glass/cubic-glass-motion-lab'
    )
  : null
const CubicGlassMotionLab = cubicGlassMotionLabModule?.CubicGlassMotionLab

export interface EmptyTasksProps {
  filter: DownloadsTab
  search: string
  hasAnyTasks: boolean
  onClearSearch: () => void
}

export function EmptyTasks({
  filter: _filter,
  search,
  hasAnyTasks,
  onClearSearch,
}: EmptyTasksProps) {
  const { t } = useTranslation()
  const interactionRef = useRef<HTMLDivElement>(null)
  const [glassEffects, setGlassEffects] = useState<CubicGlassEffects>(() => ({
    ...DEFAULT_CUBIC_GLASS_EFFECTS,
  }))
  if (!hasAnyTasks) {
    return (
      <Empty
        ref={interactionRef}
        className="relative isolate min-h-0 overflow-hidden p-0"
      >
        <CubicGlassGradient
          preset="blue-pink"
          effects={glassEffects}
          interactionRef={interactionRef}
          className="absolute inset-0 size-full"
        />
        <EmptyHeader className="relative z-10 -translate-y-6 px-8">
          <EmptyTitle>{t('panel.downloads.empty.noTasks')}</EmptyTitle>
          <EmptyDescription>
            {t('panel.downloads.empty.noTasksCta')}
          </EmptyDescription>
        </EmptyHeader>
        {CubicGlassMotionLab && (
          <CubicGlassMotionLab
            effects={glassEffects}
            onEffectsChange={setGlassEffects}
          />
        )}
      </Empty>
    )
  }
  if (search.trim()) {
    return (
      <Empty className="p-10">
        <EmptyHeader>
          <EmptyDescription>
            {t('panel.downloads.empty.noMatchSearch', { query: search })}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="ghost" onClick={onClearSearch}>
            {t('panel.downloads.empty.clearSearch')}
          </Button>
        </EmptyContent>
      </Empty>
    )
  }
  return (
    <Empty className="p-10">
      <EmptyHeader>
        <EmptyDescription>
          {t('panel.downloads.empty.noMatchFilter')}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
