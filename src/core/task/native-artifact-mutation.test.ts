import { expect, it, vi } from 'vitest'
import { createNativeArtifactMutation } from './native-artifact-mutation'

it('holds the shared task lane and plugin writer fence until the engine operation and metadata commit finish', async () => {
  const events: string[] = []
  let finish!: () => void
  const committed = new Promise<void>((resolve) => {
    finish = resolve
  })
  const run = createNativeArtifactMutation({
    acquireTaskMutationLease: async () => {
      events.push('task-locked')
      return {
        release: async () => {
          events.push('task-released')
        },
      }
    },
    quiesceArtifactWriters: async () => {
      events.push('plugins-quiesced')
      return async () => {
        events.push('plugins-resumed')
      }
    },
  })
  const running = run('task', async () => {
    events.push('native-rename')
    await committed
    events.push('metadata-committed')
  })
  await vi.waitFor(() =>
    expect(events).toEqual(['task-locked', 'plugins-quiesced', 'native-rename'])
  )
  finish()
  await running
  expect(events).toEqual([
    'task-locked',
    'plugins-quiesced',
    'native-rename',
    'metadata-committed',
    'plugins-resumed',
    'task-released',
  ])
})
it('does not call the engine if plugin writers cannot be quiesced', async () => {
  const release = vi.fn(async () => {}),
    operation = vi.fn()
  const run = createNativeArtifactMutation({
    acquireTaskMutationLease: async () => ({ release }),
    quiesceArtifactWriters: async () => {
      throw new Error('writer busy')
    },
  })
  await expect(run('task', operation)).rejects.toThrow('writer busy')
  expect(operation).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
})
it('restores plugin admission and releases the task lane when the engine rejects the operation', async () => {
  const release = vi.fn(async () => {}),
    resume = vi.fn(async () => {})
  const run = createNativeArtifactMutation({
    acquireTaskMutationLease: async () => ({ release }),
    quiesceArtifactWriters: async () => resume,
  })
  await expect(
    run('task', async () => {
      throw new Error('destination exists')
    })
  ).rejects.toThrow('destination exists')
  expect(resume).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
})
