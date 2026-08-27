import { describe, expect, it, vi } from 'vitest'
import { Aria2SegmentClient } from './aria2-segment-client'

interface Aria2Event {
  gid: string
}

function makeFakeRpc() {
  let completeHandler: ((e: Aria2Event) => void) | null = null
  let errorHandler: ((e: Aria2Event) => void) | null = null
  const addUriCalls: {
    uris: string[]
    options: Record<string, string | string[]>
  }[] = []
  const forceRemoveCalls: string[] = []

  const tellStatusCalls: { gid: string; keys?: string[] }[] = []
  let tellStatusImpl: (
    gid: string,
    keys?: string[]
  ) => Promise<{ completedLength?: string; totalLength?: string }> = () =>
    Promise.resolve({ completedLength: '0', totalLength: '0' })

  return {
    rpc: {
      addUri: vi.fn(
        (uris: string[], options: Record<string, string | string[]>) => {
          addUriCalls.push({ uris, options })
          return Promise.resolve('gid-1')
        }
      ),
      forceRemove: vi.fn((gid: string) => {
        forceRemoveCalls.push(gid)
        return Promise.resolve('gid-1')
      }),
      tellStatus: vi.fn((gid: string, keys?: string[]) => {
        tellStatusCalls.push({ gid, keys })
        return tellStatusImpl(gid, keys)
      }),
      onDownloadComplete: vi.fn((handler: (e: Aria2Event) => void) => {
        completeHandler = handler
      }),
      onDownloadError: vi.fn((handler: (e: Aria2Event) => void) => {
        errorHandler = handler
      }),
    },
    fireComplete: (gid: string) => completeHandler?.({ gid }),
    fireError: (gid: string) => errorHandler?.({ gid }),
    setTellStatus: (
      impl: (
        gid: string,
        keys?: string[]
      ) => Promise<{ completedLength?: string; totalLength?: string }>
    ) => {
      tellStatusImpl = impl
    },
    addUriCalls,
    forceRemoveCalls,
    tellStatusCalls,
  }
}

describe('Aria2SegmentClient', () => {
  it('fan-out: two onComplete subscribers both receive the gid', () => {
    const { rpc, fireComplete } = makeFakeRpc()
    const client = new Aria2SegmentClient(rpc)
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    client.onComplete(cb1)
    client.onComplete(cb2)
    fireComplete('gid-99')
    expect(cb1).toHaveBeenCalledWith('gid-99')
    expect(cb2).toHaveBeenCalledWith('gid-99')
  })

  it('fan-out: two onError subscribers both receive the gid', () => {
    const { rpc, fireError } = makeFakeRpc()
    const client = new Aria2SegmentClient(rpc)
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    client.onError(cb1)
    client.onError(cb2)
    fireError('gid-99')
    expect(cb1).toHaveBeenCalledWith('gid-99')
    expect(cb2).toHaveBeenCalledWith('gid-99')
  })

  it('addUri forwards uris and maps opts to string aria2 options', async () => {
    const { rpc, addUriCalls } = makeFakeRpc()
    const client = new Aria2SegmentClient(rpc)
    const gid = await client.addUri(['http://example.com/seg.ts'], {
      dir: '/tmp/media',
      out: '000001.seg',
      header: ['Cookie: foo=bar'],
      'max-tries': 5,
      'retry-wait': 3,
    })
    expect(gid).toBe('gid-1')
    expect(addUriCalls).toHaveLength(1)
    const { uris, options } = addUriCalls[0]
    expect(uris).toEqual(['http://example.com/seg.ts'])
    expect(options.dir).toBe('/tmp/media')
    expect(options.out).toBe('000001.seg')
    expect(options.header).toEqual(['Cookie: foo=bar'])
    expect(options['max-tries']).toBe('5')
    expect(options['retry-wait']).toBe('3')
    expect(options.continue).toBe('false')
  })

  it('forceRemove forwards the gid to rpc', async () => {
    const { rpc, forceRemoveCalls } = makeFakeRpc()
    const client = new Aria2SegmentClient(rpc)
    await client.forceRemove('gid-42')
    expect(forceRemoveCalls).toEqual(['gid-42'])
  })

  // C2: isSegmentGid tracking
  it('isSegmentGid returns true after addUri, false before', async () => {
    const { rpc } = makeFakeRpc()
    const client = new Aria2SegmentClient(rpc)
    expect(client.isSegmentGid('gid-1')).toBe(false)
    await client.addUri(['http://cdn/seg.ts'], { dir: '/tmp', out: 'seg.ts' })
    expect(client.isSegmentGid('gid-1')).toBe(true)
  })

  it('isSegmentGid returns false after forceRemove', async () => {
    const { rpc } = makeFakeRpc()
    const client = new Aria2SegmentClient(rpc)
    await client.addUri(['http://cdn/seg.ts'], { dir: '/tmp', out: 'seg.ts' })
    expect(client.isSegmentGid('gid-1')).toBe(true)
    await client.forceRemove('gid-1')
    expect(client.isSegmentGid('gid-1')).toBe(false)
  })

  it('keeps isSegmentGid true while rpc.forceRemove is pending (no remove-race window)', async () => {
    let resolveRemove: () => void = () => {}
    const rpc = {
      addUri: async () => 'gid-1',
      forceRemove: () =>
        new Promise<void>((r) => {
          resolveRemove = r
        }),
      tellStatus: async () => ({ completedLength: '0', totalLength: '0' }),
      onDownloadComplete: () => {},
      onDownloadError: () => {},
    }
    const client = new Aria2SegmentClient(rpc)
    await client.addUri(['http://cdn/seg.ts'], { dir: '/tmp', out: 'seg.ts' })
    expect(client.isSegmentGid('gid-1')).toBe(true)
    const p = client.forceRemove('gid-1')
    // While aria2 has NOT yet dropped the download, the gid must stay in the
    // skip-set — else the poll loop mints a phantom segment task.
    expect(client.isSegmentGid('gid-1')).toBe(true)
    resolveRemove()
    await p
    expect(client.isSegmentGid('gid-1')).toBe(false)
  })

  it('isSegmentGid returns false after a complete event fires', async () => {
    const { rpc, fireComplete } = makeFakeRpc()
    const client = new Aria2SegmentClient(rpc)
    await client.addUri(['http://cdn/seg.ts'], { dir: '/tmp', out: 'seg.ts' })
    expect(client.isSegmentGid('gid-1')).toBe(true)
    fireComplete('gid-1')
    expect(client.isSegmentGid('gid-1')).toBe(false)
  })

  it('isSegmentGid returns false after an error event fires', async () => {
    const { rpc, fireError } = makeFakeRpc()
    const client = new Aria2SegmentClient(rpc)
    await client.addUri(['http://cdn/seg.ts'], { dir: '/tmp', out: 'seg.ts' })
    expect(client.isSegmentGid('gid-1')).toBe(true)
    fireError('gid-1')
    expect(client.isSegmentGid('gid-1')).toBe(false)
  })

  // Byte-progress seam (Bug A): tellStatus delegates to the RPC, requesting
  // only the two length fields, and parses aria2's string values to numbers.
  it('tellStatus parses aria2 string lengths to numbers', async () => {
    const { rpc, setTellStatus, tellStatusCalls } = makeFakeRpc()
    setTellStatus(async () => ({
      completedLength: '1024',
      totalLength: '4096',
    }))
    const client = new Aria2SegmentClient(rpc)

    const result = await client.tellStatus('gid-7')

    expect(result).toEqual({ completedLength: 1024, totalLength: 4096 })
    // Only the two fields we need are requested (keeps the RPC payload small).
    expect(tellStatusCalls).toEqual([
      { gid: 'gid-7', keys: ['completedLength', 'totalLength'] },
    ])
  })

  it('tellStatus returns null when the RPC rejects (unknown gid / error)', async () => {
    const { rpc, setTellStatus } = makeFakeRpc()
    setTellStatus(async () => {
      throw new Error('GID not found')
    })
    const client = new Aria2SegmentClient(rpc)

    const result = await client.tellStatus('gid-gone')

    expect(result).toBeNull()
  })

  it('tellStatus returns null when a length field is missing / non-numeric', async () => {
    const { rpc, setTellStatus } = makeFakeRpc()
    setTellStatus(async () => ({ totalLength: '4096' }))
    const client = new Aria2SegmentClient(rpc)

    const result = await client.tellStatus('gid-partial')

    expect(result).toBeNull()
  })
})
