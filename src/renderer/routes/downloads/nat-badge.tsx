import { Badge } from '@renderer/components/ui/badge'
import { DropdownMenuTrigger } from '@renderer/components/ui/dropdown-menu'
import {
  NatStatusIndicator,
  NatStatusMenu,
} from '@renderer/features/nat/nat-status-menu'
import { useNatStatus } from '@renderer/hooks/use-nat-status'
import { NAT_STATUS_TEXT_KEY, natBucket } from '@renderer/lib/nat-status'
import { useTranslation } from 'react-i18next'

export function NatBadge() {
  return __MOTRIX_TARGET__ === 'electron' ? <ElectronNatBadge /> : null
}

function ElectronNatBadge() {
  const { t } = useTranslation()
  const status = useNatStatus()
  const { bucket } = natBucket(status)
  const badgeText = t(NAT_STATUS_TEXT_KEY[bucket])

  if (bucket === 'off') return null

  return (
    <NatStatusMenu status={status}>
      <DropdownMenuTrigger
        nativeButton={false}
        render={
          <Badge
            variant="secondary"
            className="cursor-pointer select-none"
            aria-label={badgeText}
          />
        }
      >
        <NatStatusIndicator
          status={status}
          className={bucket === 'settingUp' ? 'mr-1.5' : 'mr-2'}
        />
        {badgeText}
      </DropdownMenuTrigger>
    </NatStatusMenu>
  )
}
