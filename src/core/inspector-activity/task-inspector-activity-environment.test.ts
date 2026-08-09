import { describe, expect, it } from 'vitest'
import { taskInspectorActivityEnvironment } from './task-inspector-activity-environment'

describe('taskInspectorActivityEnvironment', () => {
  it('exposes deterministic clocks and the query seam only in test mode', () => {
    const options = taskInspectorActivityEnvironment({
      NODE_ENV: 'test',
      MOTRIX_E2E_ACTIVITY_WALL_NOW: '1700000000000',
      MOTRIX_E2E_ACTIVITY_MONOTONIC_NOW: '100000',
      MOTRIX_E2E_ACTIVITY_FAIL_AFTER_FIRST_QUERY: '1',
    })

    expect(options.runtime.wallNow?.()).toBe(1_700_000_000_000)
    expect(options.runtime.monotonicNow?.()).toBe(100_000)
    expect(options.query.failAfterFirstQuery).toBe(true)
  })

  it('ignores all E2E controls outside test mode', () => {
    const options = taskInspectorActivityEnvironment({
      NODE_ENV: 'production',
      MOTRIX_E2E_ACTIVITY_WALL_NOW: '1700000000000',
      MOTRIX_E2E_ACTIVITY_MONOTONIC_NOW: '100000',
      MOTRIX_E2E_ACTIVITY_FAIL_AFTER_FIRST_QUERY: '1',
    })

    expect(options).toEqual({ runtime: {}, query: {} })
  })
})
