import { onOperatorSessionLost } from '@renderer/lib/operator-auth'
import { parseDirectReplayRecipe } from '@shared/schemas/direct-replay-recipe'
import type { AddTaskPrefill } from '@shared/schemas/show-add-task-window'
import { type DownloadTask, TaskInstancePhase } from '@shared/types/task'
import { canRetryWithParameters } from '@shared/types/task-actions'
import { create } from 'zustand'

/** Credentials are entered in the form, never recovered from engine history. */
export function retryParametersPrefill(task: DownloadTask): AddTaskPrefill {
  const primary = task.instances.find(
    (instance) => instance.phase === TaskInstancePhase.HttpDownload
  )
  return {
    tab: 'links',
    urls: primary?.uris[0] || task.uris[0] || '',
    saveDir: task.saveDir,
    filename: task.finalName || task.filename || undefined,
    split: parseDirectReplayRecipe(primary?.payload)?.connections,
    referer: task.sourceMeta?.pageUrl || undefined,
  }
}

interface RetryParametersState {
  targets: readonly DownloadTask[]
  total: number
  revision: number
  openWith: (targets: readonly DownloadTask[]) => boolean
  advance: (revision: number) => boolean
  close: () => void
}

/** The queue holds task snapshots only; edited request parameters stay in the form. */
export const useRetryParametersStore = create<RetryParametersState>(
  (set, get) => ({
    targets: [],
    total: 0,
    revision: 0,
    openWith: (tasks) => {
      const targets = tasks.filter(canRetryWithParameters)
      if (get().targets.length || !targets.length) return false
      set((state) => ({
        targets,
        total: targets.length,
        revision: state.revision + 1,
      }))
      return true
    },
    advance: (revision) => {
      if (get().revision !== revision || !get().targets.length) return false
      set((state) => ({
        targets: state.targets.slice(1),
        revision: state.revision + 1,
      }))
      return true
    },
    close: () =>
      set((state) => ({ targets: [], total: 0, revision: state.revision + 1 })),
  })
)

onOperatorSessionLost(() => useRetryParametersStore.getState().close())
