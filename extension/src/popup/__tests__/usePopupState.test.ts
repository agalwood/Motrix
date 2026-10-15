import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePopupState } from '@/popup/usePopupState'

declare const browser: {
  runtime: { sendMessage: (env: unknown) => Promise<unknown> }
}

type Envelope = { kind: string; payload: unknown }

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const SERVERS = [
  {
    id: 'studio',
    name: 'Studio Server',
    url: 'wss://studio.example/ws',
    revision: 3,
    state: 'ready' as const,
  },
  {
    id: 'nas',
    name: 'Home NAS',
    url: 'wss://nas.example:16800',
    revision: 0,
    state: 'ready' as const,
  },
]

const LOCAL_ENDPOINT = {
  version: 3 as const,
  activeEndpointId: 'local',
  servers: SERVERS,
  cleanupTombstones: [],
}

const SNAPSHOT = {
  endpoint: LOCAL_ENDPOINT,
  pairing: 'stored',
  phase: 'ready',
  attemptIntent: null,
}

describe('usePopupState', () => {
  beforeEach(() => {
    vi.useRealTimers()
    browser.runtime.sendMessage = vi.fn(async (raw: unknown) => {
      const env = raw as Envelope
      if (env.kind === 'bg.getState') {
        return {
          ...SNAPSHOT,
          state: 'connected',
          server: {
            name: 'Motrix',
            version: '2.0.0',
            runtime: 'electron',
          },
        }
      }
      if (env.kind === 'bg.getEndpointConfig') return LOCAL_ENDPOINT
      if (env.kind === 'bg.activateEndpoint') {
        return {
          config: {
            ...LOCAL_ENDPOINT,
            activeEndpointId: (env.payload as { endpointId: string })
              .endpointId,
          },
        }
      }
      return { ok: true }
    })
  })

  it('loads the endpoint catalog and preserves every server while switching', async () => {
    const { result } = renderHook(() => usePopupState())

    await waitFor(() => expect(result.current.state.loading).toBe(false))
    expect(result.current.state.endpoint).toEqual(LOCAL_ENDPOINT)
    expect(result.current.state.server).toEqual({
      name: 'Motrix',
      version: '2.0.0',
      runtime: 'electron',
    })
    expect(result.current.state.capabilities.taskReveal).toBe(false)

    await act(async () => {
      await result.current.switchEndpoint('studio')
    })
    expect(result.current.state.endpoint).toEqual({
      ...LOCAL_ENDPOINT,
      activeEndpointId: 'studio',
    })

    await act(async () => {
      await result.current.switchEndpoint('local')
    })
    expect(result.current.state.endpoint).toEqual(LOCAL_ENDPOINT)

    const commands = (
      browser.runtime.sendMessage as ReturnType<typeof vi.fn>
    ).mock.calls.map(([raw]) => raw as Envelope)
    const activations = commands.filter(
      ({ kind }) => kind === 'bg.activateEndpoint'
    )
    expect(activations).toEqual([
      {
        kind: 'bg.activateEndpoint',
        payload: { endpointId: 'studio' },
      },
      {
        kind: 'bg.activateEndpoint',
        payload: { endpointId: 'local' },
      },
    ])
    expect(commands.map(({ kind }) => kind)).not.toContain(
      'bg.setEndpointConfig'
    )
    expect(commands.map(({ kind }) => kind)).not.toContain('bg.reconnect')
  })

  it('exposes the authenticated instance and directory capability to directory fields', async () => {
    browser.runtime.sendMessage = vi.fn(async (raw: unknown) => {
      if ((raw as Envelope).kind !== 'bg.getState') return { ok: true }
      return {
        ...SNAPSHOT,
        state: 'connected',
        server: {
          name: 'Motrix',
          version: '2',
          runtime: 'electron',
          instanceId: 'instance-a',
        },
        capabilities: { taskReveal: true, downloadDirectories: true },
      }
    })
    const { result } = renderHook(() => usePopupState())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    expect(result.current.state.server?.instanceId).toBe('instance-a')
    expect(result.current.state.capabilities.downloadDirectories).toBe(true)
  })

  it('reuses an unchanged polling snapshot instead of redrawing the popup', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => usePopupState())

    await vi.waitFor(() => expect(result.current.state.loading).toBe(false))
    const firstSnapshot = result.current.state

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(result.current.state).toBe(firstSnapshot)
  })

  it.each(['success', 'failure'])(
    'ignores a stale polling %s after a newer RPC health snapshot',
    async (outcome) => {
      vi.useFakeTimers()
      const stale = deferred<unknown>()
      let reads = 0
      browser.runtime.sendMessage = vi.fn(async (raw: unknown) => {
        if ((raw as Envelope).kind !== 'bg.getState') return { ok: true }
        if (++reads === 1) return stale.promise
        return {
          ...SNAPSHOT,
          state: 'connected',
          rpc: { health: 'unresponsive', lastError: null, lastSuccessAt: null },
        }
      })
      const { result } = renderHook(() => usePopupState())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(result.current.state.rpc?.health).toBe('unresponsive')
      const latest = result.current.state
      await act(async () => {
        stale.resolve(
          outcome === 'failure'
            ? { error: 'old polling error' }
            : {
                ...SNAPSHOT,
                state: 'connected',
                rpc: {
                  health: 'healthy',
                  lastError: null,
                  lastSuccessAt: null,
                },
              }
        )
      })
      expect(result.current.state).toBe(latest)
    }
  )

  it('reads taskReveal capability and clears it while switching backends', async () => {
    browser.runtime.sendMessage = vi.fn(async (raw: unknown) => {
      const env = raw as Envelope
      if (env.kind === 'bg.getState') {
        return {
          ...SNAPSHOT,
          state: 'connected',
          capabilities: { taskReveal: true },
        }
      }
      if (env.kind === 'bg.getEndpointConfig') return LOCAL_ENDPOINT
      if (env.kind === 'bg.activateEndpoint') {
        return {
          config: {
            ...LOCAL_ENDPOINT,
            activeEndpointId: (env.payload as { endpointId: string })
              .endpointId,
          },
        }
      }
      return { ok: true }
    })

    const { result } = renderHook(() => usePopupState())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    expect(result.current.state.capabilities.taskReveal).toBe(true)

    await act(async () => {
      await result.current.switchEndpoint('studio')
    })
    expect(result.current.state.capabilities.taskReveal).toBe(false)
  })

  it('does not let an older polling response overwrite a selected server', async () => {
    vi.useFakeTimers()
    const staleEndpoint = deferred<typeof LOCAL_ENDPOINT>()
    let endpointReads = 0
    browser.runtime.sendMessage = vi.fn(async (raw: unknown) => {
      const env = raw as Envelope
      if (env.kind === 'bg.getState') {
        endpointReads += 1
        const endpoint =
          endpointReads === 1 ? LOCAL_ENDPOINT : await staleEndpoint.promise
        return { ...SNAPSHOT, endpoint, state: 'connected' }
      }
      if (env.kind === 'bg.activateEndpoint') {
        return {
          config: {
            ...LOCAL_ENDPOINT,
            activeEndpointId: (env.payload as { endpointId: string })
              .endpointId,
          },
        }
      }
      return { ok: true }
    })

    const { result } = renderHook(() => usePopupState())
    await vi.waitFor(() => expect(result.current.state.loading).toBe(false))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await act(async () => {
      await result.current.switchEndpoint('studio')
    })
    expect(result.current.state.endpoint?.activeEndpointId).toBe('studio')

    await act(async () => {
      staleEndpoint.resolve(LOCAL_ENDPOINT)
      await Promise.resolve()
    })
    expect(result.current.state.endpoint?.activeEndpointId).toBe('studio')
  })

  it('acknowledges the badge error on mount', () => {
    renderHook(() => usePopupState())
    const kinds = (
      browser.runtime.sendMessage as ReturnType<typeof vi.fn>
    ).mock.calls.map(([raw]) => (raw as Envelope).kind)
    expect(kinds).toContain('bg.clearBadgeError')
  })

  it('surfaces background error envelopes instead of reading them as state', async () => {
    browser.runtime.sendMessage = vi.fn(async (raw: unknown) => {
      const env = raw as Envelope
      if (env.kind === 'bg.getState') {
        return { error: 'Background state unavailable' }
      }
      if (env.kind === 'bg.getEndpointConfig') return LOCAL_ENDPOINT
      return { ok: true }
    })

    const { result } = renderHook(() => usePopupState())

    await waitFor(() => expect(result.current.state.loading).toBe(false))
    expect(result.current.state.connection).toBe('disconnected')
    expect(result.current.state.lastError).toBe('Background state unavailable')
  })

  it('rejects a failed endpoint activation without changing local state', async () => {
    browser.runtime.sendMessage = vi.fn(async (raw: unknown) => {
      const env = raw as Envelope
      if (env.kind === 'bg.getState') return { ...SNAPSHOT, state: 'connected' }
      if (env.kind === 'bg.getEndpointConfig') return LOCAL_ENDPOINT
      if (env.kind === 'bg.activateEndpoint') {
        return { error: 'Endpoint activation failed' }
      }
      return { ok: true }
    })

    const { result } = renderHook(() => usePopupState())
    await waitFor(() => expect(result.current.state.loading).toBe(false))

    await act(async () => {
      await expect(result.current.switchEndpoint('studio')).rejects.toThrow(
        'Endpoint activation failed'
      )
    })

    const kinds = (
      browser.runtime.sendMessage as ReturnType<typeof vi.fn>
    ).mock.calls.map(([raw]) => (raw as Envelope).kind)
    expect(kinds).not.toContain('bg.setEndpointConfig')
    expect(kinds).not.toContain('bg.reconnect')
    expect(result.current.state.endpoint?.activeEndpointId).toBe('local')
  })

  it('reads a pending pairingCode straight from bg.getState', async () => {
    const pairingCode = {
      instanceId: 'motrix-desktop-1',
      run: 1,
      maxRuns: 3,
      attemptsRemaining: 2,
      deadlineMs: 1_234,
    }
    browser.runtime.sendMessage = vi.fn(async (raw: unknown) => {
      const env = raw as Envelope
      if (env.kind === 'bg.getState') {
        return { ...SNAPSHOT, state: 'handshaking', pairingCode }
      }
      if (env.kind === 'bg.getEndpointConfig') return LOCAL_ENDPOINT
      return { ok: true }
    })

    const { result } = renderHook(() => usePopupState())
    await waitFor(() => expect(result.current.state.loading).toBe(false))

    expect(result.current.state.pairingCode).toEqual(pairingCode)
  })

  it('reads recoveryExhaustedUnattended straight from bg.getState, defaulting to false', async () => {
    vi.useFakeTimers()
    let recoveryExhausted = true
    browser.runtime.sendMessage = vi.fn(async (raw: unknown) => {
      const env = raw as Envelope
      if (env.kind === 'bg.getState') {
        return {
          ...SNAPSHOT,
          state: 'disconnected',
          ...(recoveryExhausted ? { recoveryExhaustedUnattended: true } : {}),
        }
      }
      if (env.kind === 'bg.getEndpointConfig') return LOCAL_ENDPOINT
      return { ok: true }
    })

    const { result } = renderHook(() => usePopupState())
    await vi.waitFor(() => expect(result.current.state.loading).toBe(false))

    expect(result.current.state.recoveryExhaustedUnattended).toBe(true)

    // A later poll that omits the flag (the normal shape once the manager
    // moves on) must clear it, not leave it stuck true from a stale render.
    recoveryExhausted = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.state.recoveryExhaustedUnattended).toBe(false)
  })

  it('submitPairingCode sends the code over bg.submitPairingCode', async () => {
    const seen: unknown[] = []
    browser.runtime.sendMessage = vi.fn(async (raw: unknown) => {
      const env = raw as Envelope
      if (env.kind === 'bg.getState') return { ...SNAPSHOT, state: 'connected' }
      if (env.kind === 'bg.getEndpointConfig') return LOCAL_ENDPOINT
      if (env.kind === 'bg.submitPairingCode') {
        seen.push(env.payload)
        return { ok: true }
      }
      return { ok: true }
    })

    const { result } = renderHook(() => usePopupState())
    await waitFor(() => expect(result.current.state.loading).toBe(false))

    await act(async () => {
      await result.current.submitPairingCode('MTX7K2Q9')
    })

    expect(seen).toEqual([{ code: 'MTX7K2Q9' }])
  })

  it('submitPairingCode rejects when no code request is pending', async () => {
    browser.runtime.sendMessage = vi.fn(async (raw: unknown) => {
      const env = raw as Envelope
      if (env.kind === 'bg.getState') return { ...SNAPSHOT, state: 'connected' }
      if (env.kind === 'bg.getEndpointConfig') return LOCAL_ENDPOINT
      if (env.kind === 'bg.submitPairingCode') {
        return { ok: false, error: 'no pairing code request is pending' }
      }
      return { ok: true }
    })

    const { result } = renderHook(() => usePopupState())
    await waitFor(() => expect(result.current.state.loading).toBe(false))

    await expect(result.current.submitPairingCode('MTX7K2Q9')).rejects.toThrow(
      'no pairing code request is pending'
    )
  })

  it('rejects an endpoint id that is not present in the catalog', async () => {
    const { result } = renderHook(() => usePopupState())
    await waitFor(() => expect(result.current.state.loading).toBe(false))

    await act(async () => {
      await expect(result.current.switchEndpoint('missing')).rejects.toThrow(
        'Motrix Server is not configured'
      )
    })

    const kinds = (
      browser.runtime.sendMessage as ReturnType<typeof vi.fn>
    ).mock.calls.map(([raw]) => (raw as Envelope).kind)
    expect(kinds).not.toContain('bg.activateEndpoint')
  })
})
