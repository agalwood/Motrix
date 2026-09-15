import { EngineBadge } from './engine-badge'
import { NatBadge } from './nat-badge'
import { SpeedLimitBadge } from './speed-limit-badge'
import { TransferSpeedBadge } from './transfer-speed-badge'

export function GlobalStatsBar() {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <SpeedLimitBadge />
        <TransferSpeedBadge />
      </div>
      <div className="flex shrink-0 items-center gap-3 text-[11.5px]">
        <NatBadge />
        <EngineBadge />
      </div>
    </>
  )
}
