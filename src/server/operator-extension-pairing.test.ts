import type { PendingPairRequestInfo } from '@shared/protocol/bridge'
import { describe, expect, it, vi } from 'vitest'
import {
  type PairingTerminal,
  runExtensionPairingTerminal,
  terminalPairingText,
} from './operator-extension-pairing'

const code = '0123-4567'
const entry = {
  kind: 'extension' as const,
  pairingNonce: 'n'.repeat(43),
  extensionId: 'a'.repeat(32),
  browser: 'chromium' as const,
  identity: 'unverified' as const,
  code,
  verifiedOrigin: `chrome-extension://${'a'.repeat(32)}`,
  claimedExtensionId: 'a'.repeat(32),
  publicAuthority: 'nas.local:16801',
  createdAt: 1_000,
  expiresAt: 121_000,
}

function harness(
  snapshots: PendingPairRequestInfo[][] = [[entry], [entry], []]
) {
  const controller = new AbortController()
  let now = 2_000
  const frames: string[][] = []
  const terminal: PairingTerminal = {
    interactive: true,
    signal: controller.signal,
    begin: vi.fn(),
    show: vi.fn((lines) => frames.push(lines)),
    select: vi.fn(async () => '1'),
    clear: vi.fn(),
    close: vi.fn(),
  }
  const options = {
    terminal,
    listPending: vi.fn(async () => snapshots.shift() ?? []),
    now: () => now,
    wait: vi.fn(async (ms: number) => {
      now += ms
    }),
    t: (key: string, values?: Readonly<Record<string, string | number>>) =>
      `${key} ${JSON.stringify(values ?? {})}`,
  }
  return {
    terminal,
    options,
    frames,
    controller,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('interactive Extension pairing', () => {
  it('shows one explicitly selected code after revalidation and treats disappearance as ended', async () => {
    const h = harness()
    await expect(runExtensionPairingTerminal(h.options)).resolves.toBe('ended')
    expect(h.frames[0].join('')).not.toContain(code)
    expect(h.frames[1].join('')).toContain(code)
    expect(h.options.listPending).toHaveBeenCalledTimes(3)
    expect(h.terminal.close).toHaveBeenCalledOnce()
  })
  it('rejects a non-TTY before reading any request', async () => {
    const h = harness()
    h.options.terminal = { ...h.terminal, interactive: false }
    await expect(runExtensionPairingTerminal(h.options)).rejects.toMatchObject({
      reason: 'ttyRequired',
    })
    expect(h.options.listPending).not.toHaveBeenCalled()
  })
  it.each(['0', '-1', '2', 'all', '', '1; echo secret'])(
    'rejects selection %j without showing a code',
    async (value) => {
      const h = harness()
      h.terminal.select = async () => value
      await expect(
        runExtensionPairingTerminal(h.options)
      ).rejects.toMatchObject({ reason: 'invalidSelection' })
      expect(h.frames.flat().join('')).not.toContain(code)
      expect(h.terminal.close).toHaveBeenCalledOnce()
    }
  )
  it.each([
    { pairingNonce: 'another-nonce' },
    { code: '9999-9999' },
    { expiresAt: entry.expiresAt + 1 },
    { createdAt: entry.createdAt + 1 },
    { verifiedOrigin: 'chrome-extension://other' },
    { claimedExtensionId: 'other' },
    { identity: 'official' as const },
    { publicAuthority: 'other' },
  ])('refuses session substitution or drift %j', async (change) => {
    const h = harness([[entry], [{ ...entry, ...change }]])
    await expect(runExtensionPairingTerminal(h.options)).rejects.toMatchObject({
      reason: 'unavailable',
    })
    expect(h.frames.flat().join('')).not.toContain(code)
  })
  it('preserves the initial selection even if rows reorder', async () => {
    const other = { ...entry, pairingNonce: 'other', code: '9999-9999' }
    const h = harness([[entry, other], [other, entry], []])
    await runExtensionPairingTerminal(h.options)
    expect(h.frames[1].join('')).toContain(code)
    expect(h.frames.flat().join('')).not.toContain(other.code)
  })
  it('does not show a code after its deadline passes while choosing', async () => {
    const h = harness()
    h.terminal.select = async () => {
      h.advance(120_000)
      return '1'
    }
    await expect(runExtensionPairingTerminal(h.options)).rejects.toMatchObject({
      reason: 'unavailable',
    })
    expect(h.frames.flat().join('')).not.toContain(code)
  })
  it('cleans the display on network failure without copying the code into an error', async () => {
    const h = harness()
    h.options.listPending
      .mockImplementationOnce(async () => [entry])
      .mockImplementationOnce(async () => [entry])
      .mockRejectedValueOnce(new Error('offline'))
    await expect(runExtensionPairingTerminal(h.options)).rejects.toThrow(
      'offline'
    )
    expect(h.terminal.close).toHaveBeenCalledOnce()
  })
  it('cleans the display on cancellation', async () => {
    const h = harness()
    h.terminal.select = async () => {
      h.controller.abort()
      throw new Error('aborted')
    }
    await expect(runExtensionPairingTerminal(h.options)).rejects.toMatchObject({
      reason: 'cancelled',
    })
    expect(h.terminal.close).toHaveBeenCalledOnce()
  })
  it('removes terminal controls and bidi marks and bounds metadata', () => {
    const result = terminalPairingText(
      `\x1b]52;secret\x07\n\r\u202eevil${'x'.repeat(200)}`
    )
    expect(result).not.toMatch(/[\p{Cc}\p{Cf}]/u)
    expect(result.length).toBe(160)
  })
})
