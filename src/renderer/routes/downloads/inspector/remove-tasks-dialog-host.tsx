import { RemoveTasksDialog } from './remove-tasks-dialog'
import { useRemoveTasksStore } from './remove-tasks-store'
import { useTaskActions } from './use-task-actions'

const EMPTY = [] as const
export function RemoveTasksDialogHost() {
  const state = useRemoveTasksStore()
  const actions = useTaskActions(EMPTY)
  return (
    <RemoveTasksDialog
      open={state.open}
      busy={state.busy}
      selected={state.targets}
      preCheckDeleteFiles={state.preCheckDeleteFiles}
      onOpenChange={(open) => {
        if (!open) actions.closeRemoveDialog()
      }}
      onConfirm={(deleteFiles) => void actions.confirmRemove(deleteFiles)}
    />
  )
}
