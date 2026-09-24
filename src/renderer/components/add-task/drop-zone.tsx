import {
  type ParsedTorrentFile,
  readTorrentFile,
} from '@renderer/lib/parse-torrent-file'
import { cn } from '@renderer/lib/utils'
import { usePlatformServices } from '@renderer/platform/services'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import { Upload } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

export function DropZone({
  onFilesLoaded,
}: {
  onFilesLoaded: (files: ParsedTorrentFile[]) => void
}) {
  const { t } = useTranslation()
  const { setValue } = useFormContext<AddTaskFormValues>()
  const platform = usePlatformServices()
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadFiles = useCallback(
    async (files: FileList | File[]) => {
      const parsed: ParsedTorrentFile[] = []
      let failed = false
      for (const file of Array.from(files)) {
        try {
          parsed.push(await readTorrentFile(file))
        } catch {
          failed = true
        }
      }
      if (failed) platform.notify('error', 'task.add.parseFailed')
      if (parsed.length === 0) return

      const first = parsed[0]
      setValue('torrentMeta' as never, first.meta as never, {
        shouldDirty: true,
      })
      setValue('source' as never, 'file' as never, { shouldDirty: true })
      setValue('base64' as never, first.base64 as never, { shouldDirty: true })
      setValue(
        'selectedFiles' as never,
        first.meta.files.map((file) => file.index) as never,
        { shouldDirty: true, shouldValidate: true }
      )
      onFilesLoaded(parsed)
    },
    [onFilesLoaded, platform, setValue]
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
          if (e.dataTransfer.files.length > 0) {
            void loadFiles(e.dataTransfer.files)
          }
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
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void loadFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </>
  )
}
