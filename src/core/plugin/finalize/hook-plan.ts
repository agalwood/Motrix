import path from 'node:path'
import type { ArtifactIdentity } from './artifact-identity'

export interface FinalizeReplacement {
  pluginId: string
  stagedPath: string
  identity: ArtifactIdentity
}

export interface FinalizeMetadataOperation {
  pluginId: string
  op: 'set' | 'delete'
  key: string
  value?: unknown
  size?: number
}

export interface HookPlan {
  planId: string
  taskId: string
  saveDir: string
  sourcePath: string
  targetPath: string
  sourceIdentity: ArtifactIdentity
  replacement?: FinalizeReplacement
  metadataOps: readonly FinalizeMetadataOperation[]
  contributors: readonly string[]
}

export function assertValidHookPlan(plan: HookPlan): void {
  if (!path.isAbsolute(plan.sourcePath) || !path.isAbsolute(plan.targetPath)) {
    throw new Error('finalize paths must be absolute')
  }
  const relative = path.relative(plan.saveDir, plan.targetPath)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('finalize target must be a descendant of saveDir')
  }
  if (
    plan.replacement?.identity.kind !== undefined &&
    !plan.replacement.pluginId
  ) {
    throw new Error('replacement must identify its producing plugin')
  }
}

export function freezeHookPlan(plan: HookPlan): Readonly<HookPlan> {
  assertValidHookPlan(plan)
  return Object.freeze({
    ...plan,
    metadataOps: Object.freeze([...plan.metadataOps]),
    contributors: Object.freeze([...plan.contributors]),
    replacement: plan.replacement
      ? Object.freeze({ ...plan.replacement })
      : undefined,
  })
}
