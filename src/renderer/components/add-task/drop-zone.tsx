import { ImportFileIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import {
  type ParsedTorrentFile,
  readTorrentFile,
} from '@renderer/lib/parse-torrent-file'
import { cn } from '@renderer/lib/utils'
import { hasNasTorrentPicker, nasRequest } from '@renderer/platform/nas'
import { usePlatformServices } from '@renderer/platform/services'
import { torrentFileErrorKey } from '@shared/lib/engine-torrent'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import { useCallback, useEffect, useRef, useState } from 'react'
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
  const [selectingNas, setSelectingNas] = useState(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  const loadFiles = useCallback(
    async (files: FileList | File[]) => {
      const parsed: ParsedTorrentFile[] = []
      const failures = new Set<ReturnType<typeof torrentFileErrorKey>>()
      for (const file of Array.from(files)) {
        try {
          parsed.push(await readTorrentFile(file))
        } catch (error) {
          failures.add(torrentFileErrorKey(error))
        }
      }
      for (const key of failures) platform.notify('error', key)
      if (parsed.length === 0) return
      if (!active.current) return

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

  const selectNasTorrent = async () => {
    if (selectingNas || !platform.pickFile) return
    setSelectingNas(true)
    try {
      const candidate = await platform.pickFile({
        kind: 'open',
        extensions: ['torrent'],
      })
      if (!candidate || !active.current) return
      const response = await nasRequest('torrent', { path: candidate })
      if (!active.current) return
      await loadFiles([
        new File(
          [await response.blob()],
          candidate.split('/').at(-1) ?? 'download.torrent'
        ),
      ])
    } catch {
      if (active.current)
        platform.notify('error', 'panel.downloads.action.nasFileUnavailable')
    } finally {
      if (active.current) setSelectingNas(false)
    }
  }

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
        <ImportFileIcon
          className="h-6 w-6 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-sm text-muted-foreground">
          {t('task.add.dropTorrent')}{' '}
          <span className="font-medium text-foreground underline">
            {t('task.add.browse')}
          </span>
        </span>
      </button>
      {hasNasTorrentPicker() && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={selectingNas}
          onClick={() => void selectNasTorrent()}
        >
          {t('task.add.selectNasTorrent')}
        </Button>
      )}
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
