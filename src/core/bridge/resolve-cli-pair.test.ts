import type { ClientIdentity } from '@shared/protocol/bridge'
import { describe, expect, it, vi } from 'vitest'
import { DeviceCodeService } from './device-code-service'
import type { PairedClient, PairingService } from './pairing-service'
import { resolveCliPair } from './resolve-cli-pair'

function makeFakePairing(): PairingService {
  return {
    issueToken: async (identity: ClientIdentity, name: string) =>
      ({
        identity,
        token: 'tok',
        name,
        pairedAt: 0,
        lastActiveAt: null,
      }) as PairedClient,
  } as unknown as PairingService
}

describe('resolveCliPair', () => {
  it('approves a pending request and announces paired', async () => {
    const dc = new DeviceCodeService(makeFakePairing())
    const { requestId } = dc.request('CLI', '1')
    const onPaired = vi.fn()
    const res = await resolveCliPair(
      dc,
      { requestId, decision: 'allow' },
      onPaired
    )
    expect(res).toEqual({ ok: true })
    expect(onPaired).toHaveBeenCalledOnce()
  })

  it('returns { ok:false, reason:unavailable } for a no-longer-pending request', async () => {
    const dc = new DeviceCodeService(makeFakePairing())
    const onPaired = vi.fn()
    const res = await resolveCliPair(
      dc,
      { requestId: 'nope', decision: 'allow' },
      onPaired
    )
    expect(res).toEqual({ ok: false, reason: 'unavailable' })
    expect(onPaired).not.toHaveBeenCalled()
  })

  it('denies without throwing and reports ok', async () => {
    const dc = new DeviceCodeService(makeFakePairing())
    const { requestId } = dc.request('CLI', '1')
    const res = await resolveCliPair(
      dc,
      { requestId, decision: 'deny' },
      vi.fn()
    )
    expect(res).toEqual({ ok: true })
    expect(dc.poll(requestId)).toEqual({ status: 'denied' })
  })

  it('Fix 9: reports { ok:false, reason:unavailable } denying an unknown request', async () => {
    const dc = new DeviceCodeService(makeFakePairing())
    const res = await resolveCliPair(
      dc,
      { requestId: 'nope', decision: 'deny' },
      vi.fn()
    )
    expect(res).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('Fix 9: reports { ok:false, reason:unavailable } denying an expired request', async () => {
    let t = 1000
    const dc = new DeviceCodeService(makeFakePairing(), {
      now: () => t,
      ttlMs: 1000,
    })
    const { requestId } = dc.request('CLI', '1')
    t += 1001
    const res = await resolveCliPair(
      dc,
      { requestId, decision: 'deny' },
      vi.fn()
    )
    expect(res).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('Fix 9: reports { ok:false, reason:unavailable } denying while an approve is in flight', async () => {
    let resolveMint!: () => void
    const svc = {
      issueToken: (identity: ClientIdentity, name: string) =>
        new Promise<PairedClient>((resolve) => {
          resolveMint = () =>
            resolve({
              identity,
              token: 'tok',
              name,
              pairedAt: 0,
              lastActiveAt: null,
            })
        }),
    } as unknown as PairingService
    const dc = new DeviceCodeService(svc)
    const { requestId } = dc.request('CLI', '1')

    const approving = dc.approve(requestId)
    const res = await resolveCliPair(
      dc,
      { requestId, decision: 'deny' },
      vi.fn()
    )
    expect(res).toEqual({ ok: false, reason: 'unavailable' })

    resolveMint()
    await approving
  })
})
