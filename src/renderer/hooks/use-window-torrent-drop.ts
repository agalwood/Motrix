import { useAddTaskDialogStore } from '@renderer/components/add-task-dialog/use-add-task-dialog-store'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import {
  type ParsedTorrentFile,
  readTorrentFile,
} from '@renderer/lib/parse-torrent-file'
import { usePlatformServices } from '@renderer/platform/services'
import { useEffect } from 'react'

const isTorrentFile = (file: File) =>
  file.name.toLowerCase().endsWith('.torrent')

const hasFiles = (e: DragEvent) =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files')

/**
 * Lets the user drop .torrent files anywhere on the window to open the Add
 * Task dialog on its Torrent tab, instead of opening the dialog first.
 *
 * Skipped while the dialog is open (its own DropZone handles drops there) and
 * while signed out. Preventing the default on file drags also stops the browser
 * from navigating away to the dropped file.
 */
export function useWindowTorrentDrop(): void {
  const platform = usePlatformServices()

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
    }

    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e) || e.defaultPrevented) return
      e.preventDefault()

      if (useAddTaskDialogStore.getState().open) return
      if (useOperatorSession.getState().state !== 'authenticated') return

      const files = Array.from(e.dataTransfer?.files ?? []).filter(
        isTorrentFile
      )
      if (files.length === 0) return

      void (async () => {
        const parsed: ParsedTorrentFile[] = []
        let failed = false
        for (const file of files) {
          try {
            parsed.push(await readTorrentFile(file))
          } catch {
            failed = true
          }
        }
        if (failed) platform.notify('error', 'task.add.parseFailed')
        if (parsed.length === 0) return
        // The user may have opened the dialog while the files were parsing.
        if (useAddTaskDialogStore.getState().open) return
        useAddTaskDialogStore.getState().openWith({ tab: 'torrent' }, parsed)
      })()
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [platform])
}
