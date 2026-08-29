import { describe, expect, it, vi } from 'vitest'
import { AppliedDownloadProxyPolicy } from './applied-download-proxy-policy'

const PROXIED = {
  allProxy: 'http://proxy-user:proxy-pass@proxy.example:8080',
  noProxy: 'localhost,127.0.0.0/8',
}

describe('AppliedDownloadProxyPolicy', () => {
  it('reports whether a transition is recovering an unavailable route', async () => {
    const policy = new AppliedDownloadProxyPolicy()
    const states: boolean[] = []

    await policy.applyTransition(async ({ wasUnavailable }) => {
      states.push(wasUnavailable)
      return { downloadProxy: 'unchanged' }
    })
    policy.commit(null)
    await policy.applyTransition(async ({ wasUnavailable }) => {
      states.push(wasUnavailable)
      return { downloadProxy: 'unchanged' }
    })

    expect(states).toEqual([true, false])
  })

  it('distinguishes an unavailable policy from a confirmed direct route', async () => {
    const policy = new AppliedDownloadProxyPolicy()
    expect(policy.snapshot()).toBeNull()

    await policy.commit(null)
    expect(policy.snapshot()).toEqual({ noProxy: '' })
  })

  it('keeps the exact applied proxy only in its in-memory snapshot', async () => {
    const policy = new AppliedDownloadProxyPolicy()
    await policy.commit(PROXIED)

    expect(policy.snapshot()).toEqual({
      proxy: 'http://proxy-user:proxy-pass@proxy.example:8080',
      noProxy: 'localhost,127.0.0.0/8',
    })
  })

  it('commits only after aria2 confirms a proxy transition', async () => {
    const policy = new AppliedDownloadProxyPolicy()
    await policy.commit(null)
    let observedDuringApply: unknown = 'not-called'

    await policy.applyTransition(async () => {
      observedDuringApply = policy.snapshot()
      return { downloadProxy: 'applied' as const, appliedProxy: PROXIED }
    })

    expect(observedDuringApply).toBeNull()
    expect(policy.snapshot()).toMatchObject({
      proxy: expect.stringContaining('proxy-user:proxy-pass@'),
    })
  })

  it('stays unavailable when the engine was not ready', async () => {
    const policy = new AppliedDownloadProxyPolicy()
    await policy.commit(null)

    await policy.applyTransition(async () => ({
      downloadProxy: 'unavailable' as const,
    }))

    expect(policy.snapshot()).toBeNull()
  })

  it('stays unavailable after a partial apply failure', async () => {
    const policy = new AppliedDownloadProxyPolicy()
    await policy.commit(null)

    await expect(
      policy.applyTransition(async () => {
        throw new Error('RPC failed')
      })
    ).rejects.toThrow('RPC failed')
    expect(policy.snapshot()).toBeNull()
  })

  it('restores the prior snapshot when download routing was unchanged', async () => {
    const policy = new AppliedDownloadProxyPolicy()
    await policy.commit(PROXIED)

    await policy.applyTransition(async () => ({
      downloadProxy: 'unchanged' as const,
    }))

    expect(policy.snapshot()).toMatchObject({
      proxy: expect.stringContaining('proxy.example'),
    })
  })

  it('holds a settings writer behind active task readers', async () => {
    const policy = new AppliedDownloadProxyPolicy()
    await policy.commit(null)
    let releaseReader: (() => void) | undefined
    const readerGate = new Promise<void>((resolve) => {
      releaseReader = resolve
    })
    const events: string[] = []

    const reader = policy.runWithSnapshot(async () => {
      events.push('reader-start')
      await readerGate
      events.push('reader-end')
    })
    await vi.waitFor(() => expect(events).toEqual(['reader-start']))

    const writer = policy.applyTransition(async () => {
      events.push('writer')
      return { downloadProxy: 'applied' as const, appliedProxy: PROXIED }
    })
    await Promise.resolve()
    expect(events).toEqual(['reader-start'])

    releaseReader?.()
    await Promise.all([reader, writer])
    expect(events).toEqual(['reader-start', 'reader-end', 'writer'])
  })

  it('queues readers while an apply is in progress', async () => {
    const policy = new AppliedDownloadProxyPolicy()
    await policy.commit(null)
    let finishApply: (() => void) | undefined
    const applyGate = new Promise<void>((resolve) => {
      finishApply = resolve
    })
    const reader = vi.fn()

    const writer = policy.applyTransition(async () => {
      await applyGate
      return { downloadProxy: 'applied' as const, appliedProxy: PROXIED }
    })
    await vi.waitFor(() => expect(policy.snapshot()).toBeNull())
    const queuedReader = policy.runWithSnapshot(async (snapshot) => {
      reader(snapshot)
    })
    await Promise.resolve()
    expect(reader).not.toHaveBeenCalled()

    finishApply?.()
    await Promise.all([writer, queuedReader])
    expect(reader).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: expect.stringContaining('proxy.example'),
      })
    )
  })

  it('commits startup without waiting for a null reader and invalidates its lease', async () => {
    const policy = new AppliedDownloadProxyPolicy()
    let releaseReader: (() => void) | undefined
    const readerGate = new Promise<void>((resolve) => {
      releaseReader = resolve
    })
    let assertCurrent: (() => void) | undefined
    const reader = policy.runWithSnapshot(async (snapshot, lease) => {
      expect(snapshot).toBeNull()
      assertCurrent = lease.assertCurrent
      await readerGate
    })
    await vi.waitFor(() => expect(assertCurrent).toBeTypeOf('function'))

    policy.commit(PROXIED)

    expect(policy.snapshot()).toEqual({
      proxy: PROXIED.allProxy,
      noProxy: PROXIED.noProxy,
    })
    expect(() => assertCurrent?.()).toThrow(
      'applied download proxy policy changed'
    )
    releaseReader?.()
    await reader
  })

  it('publishes the startup route before Ready and holds queued transitions', async () => {
    const policy = new AppliedDownloadProxyPolicy()
    let releaseResolve: (() => void) | undefined
    const resolveGate = new Promise<void>((resolve) => {
      releaseResolve = resolve
    })
    const events: string[] = []

    const startup = policy.publishStartupRoute(
      async () => {
        events.push('startup-resolve')
        await resolveGate
        return PROXIED
      },
      () => events.push('ready')
    )
    await vi.waitFor(() => expect(events).toEqual(['startup-resolve']))

    const transition = policy.applyTransition(async () => {
      events.push('transition')
      return { downloadProxy: 'applied' as const, appliedProxy: null }
    })
    await Promise.resolve()
    expect(events).toEqual(['startup-resolve'])

    releaseResolve?.()
    await Promise.all([startup, transition])
    expect(events).toEqual(['startup-resolve', 'ready', 'transition'])
    expect(policy.snapshot()).toEqual({ noProxy: '' })
  })
})
