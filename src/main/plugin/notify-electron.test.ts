// Tests for ElectronNotifyHost.
//
// Mocks Electron's Notification class. Uses relative imports because
// vitest.config.ts does not alias @main.
//
// vi.mock() is hoisted to the top of the file by vitest's transformer, so
// any variables referenced inside the factory must be created with vi.hoisted()
// to be available at that point.

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Electron mock — defined via vi.hoisted so the factory can reference them.
// ---------------------------------------------------------------------------

const { instances, FakeNotification } = vi.hoisted(() => {
  const instances: Array<{
    opts: { title: string; body: string; urgency?: string }
    closed: boolean
    shown: boolean
    on: (ev: string, fn: () => void) => void
    show: () => void
    close: () => void
  }> = []

  class FakeNotification {
    static isSupported = vi.fn(() => true)
    public closed = false
    public shown = false
    private listeners = new Map<string, Array<() => void>>()

    constructor(
      public readonly opts: {
        title: string
        body: string
        urgency?: string
      }
    ) {
      instances.push(this)
    }

    on(ev: string, fn: () => void): void {
      if (!this.listeners.has(ev)) {
        this.listeners.set(ev, [])
      }
      this.listeners.get(ev)?.push(fn)
    }

    show(): void {
      this.shown = true
    }

    close(): void {
      this.closed = true
      const fns = this.listeners.get('close') ?? []
      for (const fn of fns) fn()
    }
  }

  return { instances, FakeNotification }
})

vi.mock('electron', () => ({
  Notification: FakeNotification,
}))

// ---------------------------------------------------------------------------
// Import under test (after mock is registered via vi.hoisted + vi.mock)
// ---------------------------------------------------------------------------

import { ElectronNotifyHost } from './notify-electron'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearInstances(): void {
  instances.length = 0
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ElectronNotifyHost', () => {
  beforeEach(() => {
    clearInstances()
    FakeNotification.isSupported.mockClear()
    FakeNotification.isSupported.mockReturnValue(true)
  })

  // Constructing the host must not initialize Electron's native notification
  // presenter. Electron 43 performs Windows shortcut registration as a side
  // effect of Notification.isSupported().
  it('does not query notification support during construction', () => {
    new ElectronNotifyHost()

    expect(FakeNotification.isSupported).not.toHaveBeenCalled()
  })

  // Test 1: support detection remains available on demand and is evaluated
  // only once, matching the previous snapshot semantics.
  it('resolves and caches availability lazily', () => {
    const host = new ElectronNotifyHost()

    expect(host.available).toBe(true)
    expect(host.available).toBe(true)
    expect(FakeNotification.isSupported).toHaveBeenCalledOnce()
  })

  // Test 2: show() constructs a Notification with the provided title/body.
  it('show() constructs Notification with title and body', async () => {
    const host = new ElectronNotifyHost()
    await host.show('plugin-a', { title: 'Hello', body: 'World' })
    expect(instances).toHaveLength(1)
    expect(instances[0].opts.title).toBe('Hello')
    expect(instances[0].opts.body).toBe('World')
    expect(instances[0].shown).toBe(true)
  })

  // Test 3: Dedupe — show(pid, {id: 'a'}) then show(pid, {id: 'a'}) closes the first.
  it('dedupe: second show with same id closes the first notification', async () => {
    const host = new ElectronNotifyHost()
    await host.show('plugin-a', { id: 'task-1', title: 'First', body: 'x' })
    const first = instances[0]
    expect(first.closed).toBe(false)

    await host.show('plugin-a', { id: 'task-1', title: 'Second', body: 'y' })
    expect(first.closed).toBe(true)
    expect(instances).toHaveLength(2)
    expect(instances[1].shown).toBe(true)
  })

  // Test 4: Different plugins use independent dedupe.
  it('different plugins can both show id="a" simultaneously', async () => {
    const host = new ElectronNotifyHost()
    await host.show('plugin-a', { id: 'a', title: 'A1', body: 'x' })
    await host.show('plugin-b', { id: 'a', title: 'B1', body: 'y' })
    // Neither should have been closed by the other.
    expect(instances[0].closed).toBe(false)
    expect(instances[1].closed).toBe(false)
    expect(instances).toHaveLength(2)
  })

  // Test 5: On notification close event, entry is removed from active map.
  it('on close event the entry is removed so next show does not close it', async () => {
    const host = new ElectronNotifyHost()
    await host.show('plugin-a', { id: 'task-1', title: 'First', body: 'x' })
    const first = instances[0]

    // Simulate OS closing the notification.
    first.close()
    expect(first.closed).toBe(true)

    // Show again — entry was removed so no close() on a new instance.
    await host.show('plugin-a', { id: 'task-1', title: 'Second', body: 'y' })
    // The second notification should not have been closed.
    expect(instances[1].closed).toBe(false)
  })

  // Test 6: show() without id dedupes under the default key.
  it('show() without id dedupes under the default key', async () => {
    const host = new ElectronNotifyHost()
    await host.show('plugin-a', { title: 'First', body: 'x' })
    const first = instances[0]
    await host.show('plugin-a', { title: 'Second', body: 'y' })
    expect(first.closed).toBe(true)
  })

  // Test 7: unsupported runtimes still fail when a notification is requested.
  it('checks support on first use and throws when unavailable', async () => {
    FakeNotification.isSupported.mockReturnValue(false)
    const host = new ElectronNotifyHost()

    await expect(
      host.show('plugin-a', { title: 'Hi', body: 'x' })
    ).rejects.toMatchObject({ code: 'plugin.capability.unavailable' })
    expect(host.available).toBe(false)
    expect(FakeNotification.isSupported).toHaveBeenCalledOnce()
    expect(instances).toHaveLength(0)
  })
})
