import type { OperationDefinition } from '@motrix/plugin-manifest-schema'
import {
  AudioIcon,
  CheckIcon,
  DocumentIcon,
  FolderIcon,
  PluginIcon,
  VideoIcon,
} from '@renderer/components/icons'

const icons = {
  action: PluginIcon,
  'media-merge': VideoIcon,
  document: DocumentIcon,
  checksum: CheckIcon,
}
export function OperationIcon({
  name,
}: {
  name?: OperationDefinition['icon']
}) {
  const Icon = icons[name ?? 'action']
  return <Icon className="size-4 shrink-0" aria-hidden="true" />
}

const fieldIcons = {
  video: VideoIcon,
  audio: AudioIcon,
  folder: FolderIcon,
  document: DocumentIcon,
  text: DocumentIcon,
  checksum: CheckIcon,
}
export const fieldTones = {
  neutral: '',
  blue: 'bg-blue-500/10 text-blue-500',
  violet: 'bg-violet-500/10 text-violet-500',
  amber: 'bg-amber-500/10 text-amber-500',
}
export function OperationFieldIcon({
  name,
}: {
  name?: keyof typeof fieldIcons
}) {
  const Icon = fieldIcons[name ?? 'document']
  return <Icon aria-hidden className="size-5" />
}
