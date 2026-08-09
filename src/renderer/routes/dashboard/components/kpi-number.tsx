// src/renderer/routes/dashboard/components/kpi-number.tsx
import { cn } from '@renderer/lib/utils'

export interface KpiNumberProps {
  value: string | number
  variant?: 'inherit' | 'compact'
  className?: string
  numberClassName?: string
  unitClassName?: string
}

const SIZE: Record<NonNullable<KpiNumberProps['variant']>, string> = {
  inherit: '',
  compact: 'text-[18px]',
}

const VALUE_WITH_UNIT = /^(-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)\s+(.+)$/

function splitValueUnit(
  value: string | number
): { number: string; unit: string } | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(VALUE_WITH_UNIT)
  if (!match) return null
  return { number: match[1], unit: match[2] }
}

export function KpiNumber({
  value,
  variant = 'inherit',
  className,
  numberClassName,
  unitClassName,
}: KpiNumberProps) {
  const parts = splitValueUnit(value)

  return (
    <span
      title={String(value)}
      className={cn(
        'inline-flex min-w-0 max-w-full items-baseline gap-1 font-semibold tabular-nums',
        SIZE[variant],
        className,
        // Keep the title-to-KPI rhythm stable. tailwind-merge treats an
        // arbitrary text size as carrying a line-height and otherwise drops
        // an earlier leading-none class.
        'leading-none'
      )}
      data-slot="kpi-number"
    >
      {parts ? (
        <>
          <span
            className={cn('min-w-0 truncate font-semibold', numberClassName)}
          >
            {parts.number}
          </span>{' '}
          <span
            className={cn(
              'shrink-0 text-[12px] font-normal tracking-normal text-foreground',
              unitClassName
            )}
          >
            {parts.unit}
          </span>
        </>
      ) : (
        <span className={cn('min-w-0 truncate font-semibold', numberClassName)}>
          {value}
        </span>
      )}
    </span>
  )
}
