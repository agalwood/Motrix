import {
  resolveFailureDescriptor,
  type TaskErrorFields,
} from '@shared/task-error/descriptor'

export interface FailureReason {
  reason: string
  hint: string | null
  technicalDetail: string | null
}

export interface FailureReasonI18n {
  t: (key: string, params?: Record<string, string>) => string
  exists: (key: string) => boolean
}

/**
 * Resolves a task's persisted error fields into display-ready copy: the
 * first reason candidate present in the translation catalog wins, the hint
 * is included only when its key exists, and the technical detail passes
 * through untranslated.
 */
export function resolveFailureReason(
  fields: TaskErrorFields,
  i18n: FailureReasonI18n
): FailureReason {
  const descriptor = resolveFailureDescriptor(fields)

  const candidate =
    descriptor.reasonCandidates.find((c) => i18n.exists(c.key)) ??
    descriptor.reasonCandidates[descriptor.reasonCandidates.length - 1]
  const reason = candidate ? i18n.t(candidate.key, candidate.params) : ''

  const hint =
    descriptor.hintKey && i18n.exists(descriptor.hintKey)
      ? i18n.t(descriptor.hintKey)
      : null

  return {
    reason,
    hint,
    technicalDetail: descriptor.technicalDetail,
  }
}
