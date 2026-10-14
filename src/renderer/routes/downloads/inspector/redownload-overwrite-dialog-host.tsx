import { RedownloadOverwriteDialog } from './redownload-overwrite-dialog'
import { useRedownloadOverwriteStore } from './redownload-overwrite-store'
import { useTaskActions } from './use-task-actions'

const EMPTY = [] as const

/**
 * Global host for the re-download confirmation dialog.
 */
export function RedownloadOverwriteDialogHost() {
  const state = useRedownloadOverwriteStore()
  const actions = useTaskActions(EMPTY)
  return (
    <RedownloadOverwriteDialog
      open={state.open}
      busy={state.busy}
      target={state.target}
      onOpenChange={(open) => {
        if (!open) actions.closeRedownloadOverwriteDialog()
      }}
      onConfirm={() => void actions.confirmRedownloadOverwrite()}
    />
  )
}
