import { onOperatorSessionLost } from '@renderer/lib/operator-auth'
import type { DownloadTask } from '@shared/types/task'
import { create } from 'zustand'

export const useRemoveTasksStore = create<{
  open: boolean
  preCheckDeleteFiles: boolean
  targets: readonly DownloadTask[]
  busy: boolean
}>(() => ({
  open: false,
  preCheckDeleteFiles: false,
  targets: [],
  busy: false,
}))

onOperatorSessionLost(() =>
  useRemoveTasksStore.setState({ open: false, targets: [], busy: false })
)
