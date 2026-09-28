import path from 'node:path'
import { resolveFinalizeTarget } from '@core/fs/finalize-path'
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

export function assertFinalizePaths(
  saveDir: string,
  sourcePath: string,
  targetPath: string
): void {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(targetPath)) {
    throw new Error('finalize paths must be absolute')
  }
  resolveFinalizeTarget(saveDir, targetPath)
}

export function assertValidHookPlan(plan: HookPlan): void {
  assertFinalizePaths(plan.saveDir, plan.sourcePath, plan.targetPath)
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
