import { TaskType } from '@shared/types/task'
import {
  FileDown,
  Globe,
  type LucideIcon,
  Magnet,
  Package,
  Server,
} from 'lucide-react'

export interface TaskTypeMeta {
  icon: LucideIcon
  labelKey: string
}

export const TASK_TYPE_META: Record<TaskType, TaskTypeMeta> = {
  [TaskType.Http]: { icon: Globe, labelKey: 'panel.downloads.type.http' },
  [TaskType.Magnet]: { icon: Magnet, labelKey: 'panel.downloads.type.magnet' },
  [TaskType.Bt]: { icon: FileDown, labelKey: 'panel.downloads.type.bt' },
  [TaskType.Ftp]: { icon: Server, labelKey: 'panel.downloads.type.ftp' },
  [TaskType.Metalink]: {
    icon: Package,
    labelKey: 'panel.downloads.type.metalink',
  },
}

export const TASK_TYPE_ORDER: readonly TaskType[] = [
  TaskType.Http,
  TaskType.Magnet,
  TaskType.Bt,
  TaskType.Ftp,
  TaskType.Metalink,
]
