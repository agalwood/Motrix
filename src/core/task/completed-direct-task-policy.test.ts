import { TaskStatus } from '@shared/types/task'
import { makeLegacyHttpTask } from '@test-utils/legacy-http-activation'
import { describe, expect, it } from 'vitest'
import {
  isCompletedDirectOutput,
  isDirectFinalOutput,
} from './completed-direct-task-policy'

describe('completed direct task ownership', () => {
  it('excludes completed HTTP migration originals from ordinary result retirement', () => {
    const legacy = makeLegacyHttpTask({ status: TaskStatus.Completed })
    expect(isDirectFinalOutput(legacy)).toBe(false)
    expect(isCompletedDirectOutput(legacy)).toBe(false)
    delete legacy.instances[0].payload.legacyImport
    expect(isCompletedDirectOutput(legacy)).toBe(false)
    delete legacy.instances[0].payload.legacyHttpActivation
    expect(isDirectFinalOutput(legacy)).toBe(true)
    expect(isCompletedDirectOutput(legacy)).toBe(true)
  })
})
