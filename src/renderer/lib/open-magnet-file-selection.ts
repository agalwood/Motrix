import { useAddTaskDialogStore } from '@renderer/components/add-task-dialog/use-add-task-dialog-store'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import {
  type MagnetFileSelectionPayload,
  reopenMagnetFileSelectionResultSchema,
} from '@shared/schemas/add-task'

export function showMagnetFileSelection(selection: MagnetFileSelectionPayload) {
  useAddTaskDialogStore.getState().openWith({
    tab: 'torrent',
    source: 'magnet',
    magnetUri: selection.magnetUri,
    base64: selection.torrentBase64,
    torrentMeta: selection.meta,
    selectedFiles: selection.meta.files.map((file) => file.index),
    saveDir: selection.saveDir,
    existingTaskId: selection.taskId,
  })
}

/** Web selection uses the HTTP response, so a disconnected event socket
 *  cannot leave a successful button click without a dialog. */
export async function openMagnetFileSelection(
  taskId: string,
  shouldOpen: () => boolean = () => true
): Promise<boolean> {
  const revision = useAddTaskDialogStore.getState().revision
  const result = await transport.invoke(
    Commands.ReopenMagnetFileSelection,
    taskId
  )
  if (__MOTRIX_TARGET__ === 'electron') return true
  if (!shouldOpen()) return false
  const { selection } = reopenMagnetFileSelectionResultSchema.parse(result)
  if (!selection || selection.taskId !== taskId) return false
  // The event can beat the command response. Keep the user's current edits.
  const current = useAddTaskDialogStore.getState()
  if (
    current.open &&
    current.prefill?.tab === 'torrent' &&
    current.prefill.existingTaskId === taskId
  )
    return true
  if (current.revision !== revision) return false
  showMagnetFileSelection(selection)
  return true
}
