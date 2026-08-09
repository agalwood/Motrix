import { useAddTaskDialogStore } from '@renderer/components/add-task-dialog/use-add-task-dialog-store'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type { AddTaskPrefill } from '@shared/schemas/show-add-task-window'

/**
 * Open the AddTaskDialog (electron: separate window; web: in-page modal).
 * Optional prefill is forwarded as Events.SetAddTaskMode in electron and
 * as initial form values in web.
 */
export async function openAddTaskDialog(
  prefill?: AddTaskPrefill
): Promise<void> {
  if (__MOTRIX_TARGET__ === 'electron') {
    await transport.invoke(Commands.ShowAddTaskWindow, { prefill })
  } else {
    useAddTaskDialogStore.getState().openWith(prefill)
  }
}
