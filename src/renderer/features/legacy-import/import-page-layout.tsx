import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { cn } from '@renderer/lib/utils'
import { type ReactNode, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ImportMotionScope, ImportStageContent } from './import-motion'

export type ImportStage = 'discovery' | 'selection' | 'progress' | 'result'

export function ImportPageLayout({
  active,
  stage,
  footer,
  children,
}: {
  active: boolean
  stage: ImportStage
  footer: ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <ImportMotionScope active={active}>
      <PanelShell
        title={t('legacyImport.page.assistantTitle')}
        contentClassName="overflow-hidden"
        footer={<div className="w-full py-1">{footer}</div>}
      >
        <div className="@container/import flex min-h-0 flex-1 flex-col px-6">
          <ImportStageContent key={stage}>{children}</ImportStageContent>
        </div>
      </PanelShell>
    </ImportMotionScope>
  )
}

export function ImportStageHeading({
  title,
  description,
  source,
  illustration,
  className,
}: {
  title: string
  description: string
  source?: string
  illustration?: ReactNode
  className?: string
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    // A new stage starts at its heading, not the newly repurposed primary button.
    if (heading.current?.getClientRects().length)
      heading.current.focus({ preventScroll: true })
  }, [])
  return (
    <div
      className={cn(
        'migration-stage-heading mx-auto w-full max-w-160 shrink-0 py-5 text-start',
        illustration && 'migration-stage-heading-illustrated',
        className
      )}
    >
      {illustration && (
        <div className="migration-stage-illustration mb-5 size-24" aria-hidden>
          {illustration}
        </div>
      )}
      <h2
        ref={heading}
        tabIndex={-1}
        className="text-balance text-lg font-semibold leading-tight tracking-tight outline-none"
      >
        {title}
      </h2>
      <p className="mt-1.5 text-pretty text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      {source && (
        <p
          className="mt-2 truncate text-xs text-muted-foreground"
          title={source}
        >
          {source}
        </p>
      )}
    </div>
  )
}
