import { RedownloadOverwriteDialog } from './redownload-overwrite-dialog'
import { useRedownloadOverwriteStore } from './redownload-overwrite-store'
import { useTaskActions } from './use-task-actions'

const EMPTY = [] as const

/**
 * 重新下载覆盖确认对话框的全局 Host 组件
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
