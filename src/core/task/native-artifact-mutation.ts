import type { TaskMutationLease } from '@core/inspector-activity/task-inspector-activity-runtime'

interface Deps {
  acquireTaskMutationLease(taskId: string): Promise<TaskMutationLease>
  quiesceArtifactWriters(taskId: string): Promise<() => Promise<void>>
}

/**
 * Coordinate an engine-owned operation with host finalizers and plugin writers.
 * The callback must use the engine's fenced RPC; it must not write payload files through the host.
 * Ordinary host filesystem changes retain their existing ArtifactMutationLease.
 */
export function createNativeArtifactMutation(deps: Deps) {
  return async <T>(taskId: string, operation: () => Promise<T>): Promise<T> => {
    const taskLease = await deps.acquireTaskMutationLease(taskId)
    try {
      const resume = await deps.quiesceArtifactWriters(taskId)
      try {
        return await operation()
      } finally {
        await resume()
      }
    } finally {
      await taskLease.release()
    }
  }
}

export type NativeArtifactMutation = ReturnType<
  typeof createNativeArtifactMutation
>
