import {
  DownloadActiveIcon,
  FilesReadyIcon,
  LoadingIcon,
  PauseIcon,
  QueuedIcon,
  RemoveIcon,
  SeedStatusIcon,
  StatusCompleteIcon,
  StatusErrorIcon,
} from '@renderer/components/icons'
import { cn } from '@renderer/lib/utils'
import { TaskStatus } from '@shared/types/task'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentType, SVGProps } from 'react'
import { useTranslation } from 'react-i18next'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-white',
        outline: 'bg-transparent text-foreground',
      },
    },
    defaultVariants: {
      variant: 'secondary',
    },
  }
)

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>
type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

interface StatusStyle {
  variant: BadgeVariant
  icon: IconComponent
  spin?: boolean
}

const STATUS_STYLES: Record<TaskStatus, StatusStyle> = {
  [TaskStatus.Queued]: { variant: 'outline', icon: QueuedIcon },
  [TaskStatus.FetchingMetadata]: {
    variant: 'secondary',
    icon: LoadingIcon,
    spin: true,
  },
  // Distinct icon (FileCheck2) + non-spinning so the user can tell at
  // a glance that the row is *waiting on them*, not on the network.
  [TaskStatus.MetadataReady]: { variant: 'secondary', icon: FilesReadyIcon },
  [TaskStatus.Downloading]: { variant: 'default', icon: DownloadActiveIcon },
  [TaskStatus.Finalizing]: {
    variant: 'secondary',
    icon: LoadingIcon,
    spin: true,
  },
  [TaskStatus.Seeding]: { variant: 'default', icon: SeedStatusIcon },
  [TaskStatus.Paused]: { variant: 'outline', icon: PauseIcon },
  [TaskStatus.Completed]: { variant: 'secondary', icon: StatusCompleteIcon },
  [TaskStatus.Error]: { variant: 'destructive', icon: StatusErrorIcon },
  [TaskStatus.Removed]: { variant: 'outline', icon: RemoveIcon },
}

export interface TaskStatusBadgeProps {
  status: TaskStatus
  className?: string
}

export function TaskStatusBadge({ status, className }: TaskStatusBadgeProps) {
  const { t } = useTranslation()
  const style = STATUS_STYLES[status]
  const Icon = style.icon

  const label =
    status === TaskStatus.Finalizing
      ? t('common.status.finalizing')
      : status.toLowerCase()

  return (
    <span
      data-slot="task-status-badge"
      data-status={status}
      className={cn(badgeVariants({ variant: style.variant }), className)}
    >
      <Icon
        data-testid="task-status-badge-icon"
        className={cn('size-3', style.spin && 'animate-spin')}
      />
      <span>{label}</span>
    </span>
  )
}
