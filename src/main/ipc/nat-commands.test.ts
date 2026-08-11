import type { NatManager } from '@motrix/nat'
import { ErrorCode } from '@shared/errors'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NatCommandHandlers } from './nat-commands'

interface NatManagerMock {
  enable: () => Promise<void>
  disable: () => Promise<void>
  forceRemap: () => Promise<void>
  runDiagnostic: () => Promise<void>
  exportBundle: () => Promise<{ state: string }>
}

describe('NatCommandHandlers rate limiting', () => {
  let nm: NatManagerMock
  let handlers: NatCommandHandlers
  let time = 0

  beforeEach(() => {
    time = 0
    nm = {
      enable: vi.fn().mockResolvedValue(undefined),
      disable: vi.fn().mockResolvedValue(undefined),
      forceRemap: vi.fn().mockResolvedValue(undefined),
      runDiagnostic: vi.fn().mockResolvedValue(undefined),
      exportBundle: vi.fn().mockResolvedValue({ state: 'active' }),
    }
    handlers = new NatCommandHandlers(
      nm as unknown as NatManager,
      { dialogConfirm: vi.fn() },
      { now: () => time }
    )
  })

  it('ForceRemapNat limited to 1 per 30 seconds', async () => {
    const a = await handlers.forceRemap()
    expect(a.ok).toBe(true)
    const b = await handlers.forceRemap()
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.error).toBe(ErrorCode.IpcRateLimited)

    time = 31_000
    const c = await handlers.forceRemap()
    expect(c.ok).toBe(true)
  })

  it('RunNatDiagnostic limited to 1 per 60 seconds', async () => {
    await handlers.runDiagnostic()
    const r = await handlers.runDiagnostic()
    expect(r.ok).toBe(false)
  })

  it('ExportNatBundle limited to 1 per 5 minutes', async () => {
    await handlers.exportBundle()
    const r = await handlers.exportBundle()
    expect(r.ok).toBe(false)
  })

  it('EnableNat / DisableNat limited to 1 per 5 seconds (bounce protection)', async () => {
    await handlers.enable()
    const r = await handlers.enable()
    expect(r.ok).toBe(false)
  })
})
