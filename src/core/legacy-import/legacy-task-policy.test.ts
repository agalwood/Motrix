import { makeLegacyHttpTask } from '@test-utils/legacy-http-activation'
import { describe, expect, it } from 'vitest'
import {
  getLegacyHttpBindingInput,
  getLegacyQuarantinedGids,
} from './legacy-task-policy'

describe('HTTP migration binding identity', () => {
  it('uses the original instance URI after the public engine URI changes', () => {
    const task = makeLegacyHttpTask()
    task.uris = ['https://redirect.example/temporary']
    expect(getLegacyHttpBindingInput(task)?.uri).toBe(
      'https://example.com/file.bin'
    )
    task.instances[0].uris = ['https://redirect.example/temporary']
    expect(getLegacyHttpBindingInput(task)).toBeNull()
  })

  it('quarantines both the instance and raw HTTP intent GIDs when the intent is corrupt', () => {
    const task = makeLegacyHttpTask()
    task.instances[0].payload.legacyHttpActivation = {
      version: 99,
      engineTaskId: 'abcdef1234567890',
    }
    expect(getLegacyQuarantinedGids(task)).toEqual(
      new Set([task.engineTaskId, 'abcdef1234567890'])
    )
    expect(getLegacyHttpBindingInput(task)).toBeNull()
  })

  it('does not quarantine a confirmed active binding', () => {
    expect(getLegacyQuarantinedGids(makeLegacyHttpTask()).size).toBe(0)
  })
})
