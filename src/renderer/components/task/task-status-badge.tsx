import { cn } from '@renderer/lib/utils'
import { TaskStatus } from '@shared/types/task'
import { cva, type VariantProps } from 'class-variance-authority'
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  FileCheck2,
  Loader2,
  Pause,
  Trash2,
  Upload,
} from 'lucide-react'
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
  [TaskStatus.Queued]: { variant: 'outline', icon: Clock },
  [TaskStatus.FetchingMetadata]: {
    variant: 'secondary',
    icon: Loader2,
    spin: true,
  },
  // Distinct icon (FileCheck2) + non-spinning so the user can tell at
  // a glance that the row is *waiting on them*, not on the network.
  [TaskStatus.MetadataReady]: { variant: 'secondary', icon: FileCheck2 },
  [TaskStatus.Downloading]: { variant: 'default', icon: Download },
  [TaskStatus.Finalizing]: {
    variant: 'secondary',
    icon: Loader2,
    spin: true,
  },
  [TaskStatus.Seeding]: { variant: 'default', icon: Upload },
  [TaskStatus.Paused]: { variant: 'outline', icon: Pause },
  [TaskStatus.Completed]: { variant: 'secondary', icon: CheckCircle2 },
  [TaskStatus.Error]: { variant: 'destructive', icon: AlertCircle },
  [TaskStatus.Removed]: { variant: 'outline', icon: Trash2 },
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
