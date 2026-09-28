import {
  InfoIcon,
  StatusCompleteIcon,
  StatusFailedIcon,
  WarningIcon,
} from '@renderer/components/icons'
import { cn } from '@renderer/lib/utils'
import {
  type AppNotification,
  NotificationKinds,
} from '@shared/types/notification'

const severityIcons = {
  info: { icon: InfoIcon, className: 'text-muted-foreground' },
  warning: {
    icon: WarningIcon,
    className: 'text-[#8b784d] dark:text-[#baa574]',
  },
  error: {
    icon: StatusFailedIcon,
    className: 'text-[#a96360] dark:text-[#c98f89]',
  },
}

export function NotificationIcon({ item }: { item: AppNotification }) {
  const complete = item.kind === NotificationKinds.TaskComplete
  const severity = severityIcons[item.severity] ?? severityIcons.info
  const Icon = complete ? StatusCompleteIcon : severity.icon

  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-5 w-4 shrink-0 items-center justify-center',
        complete ? 'text-muted-foreground' : severity.className
      )}
    >
      <Icon className="size-4" strokeWidth={1.5} />
    </span>
  )
}
