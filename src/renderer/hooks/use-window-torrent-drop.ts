import { useAddTaskDialogStore } from '@renderer/components/add-task-dialog/use-add-task-dialog-store'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import {
  type ParsedTorrentFile,
  readTorrentFile,
} from '@renderer/lib/parse-torrent-file'
import { usePlatformServices } from '@renderer/platform/services'
import { torrentFileErrorKey } from '@shared/lib/engine-torrent'
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
    let active = true
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
    }

    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e) || e.defaultPrevented) return
      e.preventDefault()

      if (useAddTaskDialogStore.getState().open) return
      const { state, epoch } = useOperatorSession.getState()
      if (state !== 'authenticated') return

      const files = Array.from(e.dataTransfer?.files ?? []).filter(
        isTorrentFile
      )
      if (files.length === 0) return

      void (async () => {
        const parsed: ParsedTorrentFile[] = []
        const failures = new Set<ReturnType<typeof torrentFileErrorKey>>()
        for (const file of files) {
          try {
            parsed.push(await readTorrentFile(file))
          } catch (error) {
            failures.add(torrentFileErrorKey(error))
          }
          // Session loss clears the dialog and may unmount this hook. Never
          // restore that batch or its errors, even after a subsequent login.
          const session = useOperatorSession.getState()
          if (
            !active ||
            session.state !== 'authenticated' ||
            session.epoch !== epoch
          )
            return
        }
        for (const key of failures) platform.notify('error', key)
        if (parsed.length === 0) return
        // The user may have opened the dialog while the files were parsing.
        if (useAddTaskDialogStore.getState().open) return
        useAddTaskDialogStore.getState().openWith({ tab: 'torrent' }, parsed)
      })()
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      active = false
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [platform])
}
