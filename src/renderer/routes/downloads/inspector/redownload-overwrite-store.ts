import { onOperatorSessionLost } from '@renderer/lib/operator-auth'
import type { DownloadTask } from '@shared/types/task'
import { create } from 'zustand'

/**
 * 重新下载时的覆盖确认弹窗状态管理
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
