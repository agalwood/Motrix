import { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import type { AppUpdateState } from '@shared/types/app-update'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchServerUpdateMetadata,
  ServerUpdateService,
} from './app-update-service'

afterEach(() => vi.unstubAllGlobals())

function createService(
  version = '2.2.0',
  channel: 'stable' | 'beta' = 'stable'
) {
  const eventBus = new EventBus()
  const states: AppUpdateState[] = []
  eventBus.on(Events.UpdateStateChanged, (state) =>
    states.push(state as AppUpdateState)
  )
  const loadMetadata = vi.fn<typeof fetchServerUpdateMetadata>(async () => ({
    version: '2.3.0',
  }))
  const service = new ServerUpdateService({
    eventBus,
    currentVersion: version,
    channel,
    loadMetadata,
  })
  return { service, states, loadMetadata }
}

describe('Server version checking', () => {
  it('publishes checking and available states without downloading an installer', async () => {
    const { service, states, loadMetadata } = createService()
    await service.check()
    expect(states.map((state) => state.phase)).toEqual([
      'checking',
      'available',
    ])
    expect(service.getState()).toMatchObject({
      currentVersion: '2.2.0',
      availableVersion: '2.3.0',
      updateAuthority: 'administrator',
    })
    expect(loadMetadata).toHaveBeenCalledWith('stable', expect.any(AbortSignal))
  })

  it.each([
    ['2.2.0', '2.2.0', 'stable', 'up-to-date'],
    ['2.3.0', '2.2.0', 'stable', 'up-to-date'],
    ['2.3.0-beta.10', '2.3.0-beta.9', 'beta', 'up-to-date'],
    ['2.3.0-beta.9', '2.3.0-beta.10', 'beta', 'available'],
    ['2.3.0-beta.9', '2.3.0', 'beta', 'available'],
    ['2.3.0-beta.9', '2.2.0', 'stable', 'up-to-date'],
    ['2.2.0+local', '2.2.0+release', 'stable', 'up-to-date'],
  ] as const)(
    'compares %s with %s on %s without downgrading',
    async (current, next, channel, phase) => {
      const { service, loadMetadata } = createService(current, channel)
      loadMetadata.mockResolvedValue({ version: next })
      await service.check()
      expect(service.getState().phase).toBe(phase)
    }
  )

  it.each(['2.3.0-beta.1', '2.3.0-rc.1', '02.3.0', 'garbage'])(
    'rejects an invalid stable feed version %s',
    async (version) => {
      const { service, loadMetadata } = createService()
      loadMetadata.mockResolvedValue({ version })
      await expect(service.check()).rejects.toThrow()
      expect(service.getState()).toMatchObject({
        phase: 'error',
        updateAuthority: 'administrator',
      })
    }
  )

  it('coalesces concurrent checks and retries after a failure', async () => {
    const { service, loadMetadata } = createService()
    loadMetadata.mockRejectedValueOnce(new Error('remote error detail'))
    const first = service.check()
    expect(service.check()).toBe(first)
    await expect(first).rejects.toThrow(
      'settings.about.update.errorDescription'
    )
    expect(loadMetadata).toHaveBeenCalledOnce()
    expect(JSON.stringify(service.getState())).not.toContain(
      'remote error detail'
    )
    await service.check()
    expect(service.getState().phase).toBe('available')
  })

  it('discards a response from the old channel and aborts that request', async () => {
    const { service, loadMetadata } = createService()
    let finish!: (value: { version: string }) => void
    loadMetadata.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const old = service.check()
    await vi.waitFor(() => expect(loadMetadata).toHaveBeenCalledOnce())
    const signal = vi.mocked(loadMetadata).mock.calls[0][1] as AbortSignal
    service.setChannel('beta')
    expect(signal.aborted).toBe(true)
    loadMetadata.mockResolvedValue({ version: '2.4.0-beta.1' })
    await service.check()
    finish({ version: '2.3.0' })
    await old
    expect(service.getState().availableVersion).toBe('2.4.0-beta.1')
  })
})

describe('Server published update metadata', () => {
  it.each([
    ['stable', 'latest'],
    ['beta', 'beta'],
  ] as const)(
    'reads the desktop %s feed, without following package URLs',
    async (channel, name) => {
      const fetcher = vi.fn(
        async () =>
          new Response(
            'version: 2.3.0\nreleaseName: Motrix 2.3.0\nfiles:\n  - url: https://unused.invalid/installer.exe\n'
          )
      )
      vi.stubGlobal('fetch', fetcher)
      const signal = new AbortController().signal
      await expect(
        fetchServerUpdateMetadata(channel, signal)
      ).resolves.toMatchObject({ version: '2.3.0' })
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        `https://dl.motrix.app/releases/${name}.yml`,
        expect.objectContaining({ signal, redirect: 'error' })
      )
    }
  )

  it('rejects HTTP failures and oversized responses', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('x'.repeat(256 * 1024 + 1)))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      fetchServerUpdateMetadata('stable', new AbortController().signal)
    ).rejects.toThrow('503')
    await expect(
      fetchServerUpdateMetadata('stable', new AbortController().signal)
    ).rejects.toThrow('size limit')
  })
})
