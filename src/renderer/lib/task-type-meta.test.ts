import { TaskType } from '@shared/types/task'
import { describe, expect, it } from 'vitest'
import { TASK_TYPE_META, TASK_TYPE_ORDER } from './task-type-meta'

describe('task type metadata', () => {
  it('defines one localized glyph for every task type', () => {
    for (const type of Object.values(TaskType)) {
      expect(TASK_TYPE_META[type]).toBeDefined()
      expect(TASK_TYPE_META[type].labelKey).toMatch(/^panel\.downloads\.type\./)
    }
  })

  it('keeps the filter order exhaustive and unique', () => {
    expect(new Set(TASK_TYPE_ORDER)).toEqual(new Set(Object.values(TaskType)))
    expect(TASK_TYPE_ORDER).toHaveLength(Object.values(TaskType).length)
  })
})
