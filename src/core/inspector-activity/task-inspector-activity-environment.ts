import type { TaskInspectorActivityQueryOptions } from './task-inspector-activity-query'
import type { TaskInspectorActivityRuntimeOptions } from './task-inspector-activity-runtime'

type Environment = Record<string, string | undefined>

export interface TaskInspectorActivityEnvironmentOptions {
  runtime: Pick<TaskInspectorActivityRuntimeOptions, 'wallNow' | 'monotonicNow'>
  query: TaskInspectorActivityQueryOptions
}

function fixedClock(
  raw: string | undefined,
  allowZero: boolean
): (() => number) | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    return undefined
  }
  return () => value
}

/**
 * Resolve deterministic E2E controls. Production builds intentionally ignore
 * these variables even if the surrounding process environment contains them.
 */
export function taskInspectorActivityEnvironment(
  env: Environment
): TaskInspectorActivityEnvironmentOptions {
  if (env.NODE_ENV !== 'test') return { runtime: {}, query: {} }

  const wallNow = fixedClock(env.MOTRIX_E2E_ACTIVITY_WALL_NOW, false)
  const monotonicNow = fixedClock(env.MOTRIX_E2E_ACTIVITY_MONOTONIC_NOW, true)
  return {
    runtime: {
      ...(wallNow ? { wallNow } : {}),
      ...(monotonicNow ? { monotonicNow } : {}),
    },
    query: {
      ...(env.MOTRIX_E2E_ACTIVITY_FAIL_AFTER_FIRST_QUERY === '1'
        ? { failAfterFirstQuery: true }
        : {}),
    },
  }
}
