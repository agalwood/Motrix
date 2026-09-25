import {
  HttpIcon,
  MagnetIcon,
  MetalinkIcon,
  type MotrixIcon,
  ServerIcon,
  TorrentFileIcon,
} from '@renderer/components/icons'
import { TaskType } from '@shared/types/task'

export interface TaskTypeMeta {
  icon: MotrixIcon
  labelKey: string
}

export const TASK_TYPE_META: Record<TaskType, TaskTypeMeta> = {
  [TaskType.Http]: { icon: HttpIcon, labelKey: 'panel.downloads.type.http' },
  [TaskType.Magnet]: {
    icon: MagnetIcon,
    labelKey: 'panel.downloads.type.magnet',
  },
  [TaskType.Bt]: { icon: TorrentFileIcon, labelKey: 'panel.downloads.type.bt' },
  [TaskType.Ftp]: { icon: ServerIcon, labelKey: 'panel.downloads.type.ftp' },
  [TaskType.Metalink]: {
    icon: MetalinkIcon,
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
