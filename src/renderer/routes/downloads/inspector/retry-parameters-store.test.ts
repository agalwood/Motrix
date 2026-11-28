import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ lost: () => {} }))
vi.mock('@renderer/lib/operator-auth', () => ({
  onOperatorSessionLost: (handler: () => void) => {
    auth.lost = handler
  },
}))

import {
  retryParametersPrefill,
  useRetryParametersStore,
} from './retry-parameters-store'

describe('retry parameter queue', () => {
  beforeEach(() => useRetryParametersStore.getState().close())
  const task = makeDownloadTask({
    status: TaskStatus.Error,
    uris: ['https://example.com/archive.zip'],
    finalName: 'archive.zip',
    saveDir: '/downloads',
  })

  it('keeps the current draft when another retry is requested', () => {
    expect(useRetryParametersStore.getState().openWith([task])).toBe(true)
    expect(
      useRetryParametersStore.getState().openWith([{ ...task, id: 'other' }])
    ).toBe(false)
    expect(useRetryParametersStore.getState().targets).toEqual([task])
  })

  it('does not let a late submission advance a newly opened queue', () => {
    useRetryParametersStore.getState().openWith([task])
    const old = useRetryParametersStore.getState().revision
    useRetryParametersStore.getState().close()
    const next = { ...task, id: 'next' }
    useRetryParametersStore.getState().openWith([next])
    expect(useRetryParametersStore.getState().advance(old)).toBe(false)
    expect(useRetryParametersStore.getState().targets).toEqual([next])
  })

  it('advances each queue item once and resets when authorization is lost', () => {
    useRetryParametersStore.getState().openWith([task, { ...task, id: 'next' }])
    const old = useRetryParametersStore.getState().revision
    expect(useRetryParametersStore.getState().advance(old)).toBe(true)
    expect(useRetryParametersStore.getState().advance(old)).toBe(false)
    expect(useRetryParametersStore.getState().targets).toHaveLength(1)
    auth.lost()
    expect(useRetryParametersStore.getState().targets).toHaveLength(0)
  })

  it('prefills public task fields without reconstructing credentials', () => {
    expect(retryParametersPrefill(task)).toEqual({
      tab: 'links',
      urls: 'https://example.com/archive.zip',
      filename: 'archive.zip',
      saveDir: '/downloads',
      split: undefined,
      referer: undefined,
    })
    expect(retryParametersPrefill(task)).not.toHaveProperty('cookie')
    expect(retryParametersPrefill(task)).not.toHaveProperty('authorization')
  })
})
