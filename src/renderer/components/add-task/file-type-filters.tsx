import { Button } from '@renderer/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { VIDEO_FILE_EXTENSIONS } from '@shared/constants/file-types'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import { FileText, Film, Image, Music } from 'lucide-react'
import type { ReactNode } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

const FILTERS: Array<{
  id: 'video' | 'audio' | 'image' | 'doc'
  icon: ReactNode
  exts: string[]
}> = [
  {
    id: 'video',
    icon: <Film className="h-3.5 w-3.5" />,
    exts: [...VIDEO_FILE_EXTENSIONS],
  },
  {
    id: 'audio',
    icon: <Music className="h-3.5 w-3.5" />,
    exts: ['.mp3', '.flac', '.aac', '.ogg', '.wav', '.wma', '.m4a', '.opus'],
  },
  {
    id: 'image',
    icon: <Image className="h-3.5 w-3.5" />,
    exts: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico'],
  },
  {
    id: 'doc',
    icon: <FileText className="h-3.5 w-3.5" />,
    exts: ['.pdf', '.doc', '.docx', '.txt', '.epub', '.mobi', '.rtf', '.md'],
  },
]

export function FileTypeFilters() {
  const { t } = useTranslation()
  const { setValue } = useFormContext<AddTaskFormValues>()
  const meta = useWatch<AddTaskFormValues, 'torrentMeta'>({
    name: 'torrentMeta',
  })
  const selected = useWatch<AddTaskFormValues, 'selectedFiles'>({
    name: 'selectedFiles',
  })

  if (!meta) return null

  const addByExts = (exts: string[]) => {
    const extSet = new Set(exts)
    const matching = meta.files
      .filter((f) => extSet.has(f.extension.toLowerCase()))
      .map((f) => f.index)
    const merged = Array.from(new Set([...(selected ?? []), ...matching]))
    setValue('selectedFiles', merged, {
      shouldDirty: true,
      shouldValidate: true,
    })
  }

  return (
    <TooltipProvider>
      <div className="flex gap-1">
        {FILTERS.map(({ id, icon, exts }) => {
          const label = t(`task.add.filterBy.${id}`)

          return (
            <Tooltip key={id}>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    onClick={() => addByExts(exts)}
                    aria-label={label}
                    className="h-7 gap-0.5 px-2 text-muted-foreground hover:text-foreground"
                  />
                }
              >
                {icon}
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
