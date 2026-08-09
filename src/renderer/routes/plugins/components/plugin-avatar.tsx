import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@renderer/components/ui/avatar'
import { cn } from '@renderer/lib/utils'
import type { PluginListDTO, PluginManifest } from '@shared/types/plugin'
import { abbreviatePluginName, avatarToneFor } from '../lib/audience'

interface Props {
  plugin: Pick<PluginListDTO | PluginManifest, 'id' | 'name'> & {
    icon?: string
  }
  size?: number
}

export function PluginAvatar({ plugin, size = 46 }: Props) {
  const tone = avatarToneFor(plugin.id)
  return (
    <Avatar className="rounded-md" style={{ width: size, height: size }}>
      {plugin.icon && <AvatarImage src={plugin.icon} alt={plugin.name} />}
      <AvatarFallback
        className={cn('rounded-md text-sm font-semibold', tone.bg, tone.text)}
      >
        {abbreviatePluginName(plugin.name)}
      </AvatarFallback>
    </Avatar>
  )
}
