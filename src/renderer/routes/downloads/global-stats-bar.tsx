import { useSyncExternalStore } from 'react'
import { DownloadsMoreMenu } from './downloads-more-menu'
import { DownloadsStatusPopover } from './downloads-status-popover'
import { EngineBadge } from './engine-badge'
import { NatBadge } from './nat-badge'
import { SpeedLimitBadge } from './speed-limit-badge'
import { TransferSpeedBadge } from './transfer-speed-badge'

const COMPACT_STATS_QUERY = '(max-width: 375px)'

function compactStatsRequested() {
  return window.matchMedia?.(COMPACT_STATS_QUERY).matches === true
}

function subscribeWindowSize(listener: () => void) {
  const query = window.matchMedia?.(COMPACT_STATS_QUERY)
  query?.addEventListener('change', listener)
  return () => query?.removeEventListener('change', listener)
}

export function GlobalStatsBar() {
  const compact = useSyncExternalStore(
    subscribeWindowSize,
    compactStatsRequested,
    () => false
  )

  return (
    <div
      data-slot="downloads-stats-bar"
      data-compact={compact}
      className="flex w-full min-w-0 items-center gap-2"
    >
      <DownloadsMoreMenu />
      {compact ? (
        <DownloadsStatusPopover />
      ) : (
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <SpeedLimitBadge />
            <TransferSpeedBadge />
          </div>
          <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <NatBadge />
            <EngineBadge />
          </div>
        </div>
      )}
    </div>
  )
}
