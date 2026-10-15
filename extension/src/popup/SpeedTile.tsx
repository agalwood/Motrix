import { cn } from '@/lib/utils'
import { DashboardTile } from '@/popup/DashboardTile'

const SPEED_UNITS = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s', 'PB/s'] as const

export type SpeedTileKind = 'upload' | 'download'

export interface SpeedTileProps {
  kind: SpeedTileKind
  label: string
  bytesPerSecond: number | null
  className?: string
}

interface SpeedParts {
  number: string
  unit: (typeof SPEED_UNITS)[number]
}

const ACCENT_CLASS: Record<SpeedTileKind, { band: string; line: string }> = {
  upload: {
    band: 'bg-speed-upload/[0.12]',
    line: 'bg-speed-upload',
  },
  download: {
    band: 'bg-speed-download/[0.12]',
    line: 'bg-speed-download',
  },
}

function formatSpeed(bytesPerSecond: number): SpeedParts {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 1) {
    return { number: '0', unit: 'B/s' }
  }

  let value = bytesPerSecond
  let unitIndex = 0
  while (value >= 1024 && unitIndex < SPEED_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const number =
    unitIndex === 0
      ? Math.floor(value).toString()
      : value >= 100
        ? Math.round(value).toString()
        : value.toFixed(1)

  return { number, unit: SPEED_UNITS[unitIndex] ?? 'B/s' }
}

// Adapted from Motrix's MIT-licensed dashboard tile visual layer.
export function SpeedTile({
  kind,
  label,
  bytesPerSecond,
  className,
}: SpeedTileProps): React.ReactElement {
  const speed = bytesPerSecond === null ? null : formatSpeed(bytesPerSecond)
  const accent = ACCENT_CLASS[kind]

  return (
    <DashboardTile
      label={label}
      value={speed?.number ?? '—'}
      {...(speed ? { unit: speed.unit } : {})}
      {...(className === undefined ? {} : { className })}
      decoration={
        <>
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-x-0 bottom-0 h-2',
              accent.band
            )}
          />
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-x-0 bottom-2 h-px',
              accent.line
            )}
          />
        </>
      }
    />
  )
}
