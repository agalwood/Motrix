import { onOperatorSessionLost } from '@renderer/lib/operator-auth'
import type { DownloadTask } from '@shared/types/task'
import { create } from 'zustand'

/**
 * Shared state for the re-download confirmation dialog.
 */
export const useRedownloadOverwriteStore = create<{
  open: boolean
  target: DownloadTask | null
  busy: boolean
}>(() => ({
  open: false,
  target: null,
  busy: false,
}))

onOperatorSessionLost(() =>
  useRedownloadOverwriteStore.setState({
    open: false,
    target: null,
    busy: false,
  })
)
