import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { usePlatformServices } from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import type { TorrentMeta } from '@shared/types/torrent'
import { Upload } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

export function DropZone() {
  const { t } = useTranslation()
  const { setValue } = useFormContext<AddTaskFormValues>()
  const platform = usePlatformServices()
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadFile = useCallback(
    async (file: File) => {
      try {
        const buf = await file.arrayBuffer()
        const bytes = new Uint8Array(buf)
        const chunks: string[] = []
        for (let i = 0; i < bytes.length; i += 8192) {
          chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)))
        }
        const base64 = btoa(chunks.join(''))
        const meta = (await transport.invoke(Commands.ParseTorrent, {
          base64,
        })) as TorrentMeta
        setValue('torrentMeta' as never, meta as never, { shouldDirty: true })
        setValue('source' as never, 'file' as never, { shouldDirty: true })
        setValue('base64' as never, base64 as never, { shouldDirty: true })
        setValue(
          'selectedFiles' as never,
          meta.files.map((f) => f.index) as never,
          { shouldDirty: true, shouldValidate: true }
        )
      } catch {
        platform.notify('error', 'task.add.parseFailed')
      }
    },
    [setValue, platform]
  )

  return (
    <>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files[0]
          if (file) loadFile(file)
        }}
        className={cn(
          'flex h-40 w-full flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed transition-colors',
          dragOver ? 'border-ring bg-muted' : 'border-border hover:border-ring'
        )}
      >
        <Upload className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm text-muted-foreground">
          {t('task.add.dropTorrent')}{' '}
          <span className="font-medium text-foreground underline">
            {t('task.add.browse')}
          </span>
        </span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".torrent"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) loadFile(file)
          e.target.value = ''
        }}
      />
    </>
  )
}
