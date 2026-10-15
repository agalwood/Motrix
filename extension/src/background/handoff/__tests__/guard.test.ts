import { describe, expect, it, vi } from 'vitest'
import { BackendOperationCoordinator } from '@/background/BackendOperationCoordinator'
import type { EndpointConfig } from '@/background/EndpointConfigStore'
import {
  HandoffEndpointChangedError,
  HandoffEndpointTracker,
} from '@/background/handoff/guard'

function fixture() {
  let config: EndpointConfig = {
    version: 3,
    activeEndpointId: 'local',
    servers: [],
    cleanupTombstones: [],
  }
  const coordinator = new BackendOperationCoordinator()
  const store = { getForLifecycleMutation: vi.fn(async () => config) }
  const tracker = new HandoffEndpointTracker(store, coordinator)
  const select = (activeEndpointId: string) =>
    coordinator.run(async () => {
      tracker.invalidate()
      config = { ...config, activeEndpointId }
    })
  return { tracker, coordinator, store, select }
}

describe('handoff endpoint lifetime', () => {
  it('skips remote automatic interception, including an unavailable selected profile', async () => {
    const { tracker, select } = fixture()
    await select('nas')
    expect(await tracker.capture('auto')).toBeNull()
    const explicit = await tracker.capture('context-menu')
    expect(explicit?.origin).toBe('context-menu')
    expect(() => explicit?.assertCurrent()).not.toThrow()
  })

  it('invalidates in-flight local downloads even after switching back to local', async () => {
    const { tracker, select } = fixture()
    const original = await tracker.capture('auto')
    expect(original).not.toBeNull()
    await select('nas')
    await select('local')
    expect(() => original?.assertCurrent()).toThrow(HandoffEndpointChangedError)
    const current = await tracker.capture('auto')
    expect(() => current?.assertCurrent()).not.toThrow()
  })

  it('waits for a catalog write instead of reading an intermediate selection', async () => {
    const { tracker, coordinator, select, store } = fixture()
    let release!: () => void
    const pending = coordinator.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await Promise.resolve()
    const switching = select('nas')
    const capturing = tracker.capture('auto')
    expect(store.getForLifecycleMutation).not.toHaveBeenCalled()
    release()
    await pending
    await switching
    expect(await capturing).toBeNull()
  })
})
