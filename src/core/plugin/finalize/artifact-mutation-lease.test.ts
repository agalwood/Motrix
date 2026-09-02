import { describe, expect, it, vi } from 'vitest'
import { ArtifactMutationLeaseCoordinator } from './artifact-mutation-lease'

describe('ArtifactMutationLeaseCoordinator', () => {
  it('quiesces every writer and resumes in reverse order', async () => {
    const events: string[] = []
    const coordinator = new ArtifactMutationLeaseCoordinator([
      { quiesce: async () => () => void events.push('resume-engine') },
      { quiesce: async () => () => void events.push('resume-host') },
    ])
    const lease = await coordinator.acquire('task-1')
    expect(coordinator.isHeld('task-1')).toBe(true)
    await lease.release()
    expect(events).toEqual(['resume-host', 'resume-engine'])
    expect(coordinator.isHeld('task-1')).toBe(false)
  })

  it('fails closed and rolls back already-quiesced writers', async () => {
    const resume = vi.fn()
    const coordinator = new ArtifactMutationLeaseCoordinator([
      { quiesce: async () => resume },
      { quiesce: async () => Promise.reject(new Error('engine busy')) },
    ])
    await expect(coordinator.acquire('task-1')).rejects.toThrow('engine busy')
    expect(resume).toHaveBeenCalledOnce()
    expect(coordinator.isHeld('task-1')).toBe(false)
  })

  it('rejects concurrent mutation of the same task', async () => {
    const coordinator = new ArtifactMutationLeaseCoordinator([])
    const lease = await coordinator.acquire('task-1')
    await expect(coordinator.acquire('task-1')).rejects.toThrow('already held')
    await lease.release()
  })
})
