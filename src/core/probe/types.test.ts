import { describe, expect, it, vi } from 'vitest'

const { mockExecFile, mockStatfsSync } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockStatfsSync: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
  default: { execFile: mockExecFile },
}))
vi.mock('node:fs', () => ({
  statfsSync: mockStatfsSync,
  default: { statfsSync: mockStatfsSync },
}))

import { defaultExec, getFreeBytes } from './types'

describe('defaultExec', () => {
  it('passes a timeout option so a hung subprocess cannot block forever', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (e: Error | null, out: string) => void
      ) => cb(null, 'ok')
    )

    await defaultExec('diskutil', ['info', '/'])

    // execFile must be called as (cmd, args, options, callback) with a
    // positive timeout — not the old (cmd, args, callback) with no timeout.
    const opts = mockExecFile.mock.calls[0]?.[2] as { timeout?: number }
    expect(typeof opts?.timeout).toBe('number')
    expect(opts.timeout).toBeGreaterThan(0)
  })
})

describe('getFreeBytes', () => {
  it('uses bavail (not bfree) so root-reserved blocks are excluded', () => {
    mockStatfsSync.mockReturnValue({
      bsize: 4096,
      blocks: 1000,
      bfree: 100,
      bavail: 80,
      files: 0,
      ffree: 0,
    })
    // bavail*bsize, not bfree*bsize (which would over-report by the reserve).
    expect(getFreeBytes('/x')).toBe(80 * 4096)
  })

  it('returns null when statfs throws', () => {
    mockStatfsSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(getFreeBytes('/x')).toBeNull()
  })
})
