import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- JavaScript runner intentionally has no declarations
import {
  parseRemoteExtensionSoakRepeats,
  runRemoteExtensionSoak,
} from '../../scripts/run-remote-extension-soak.mjs'

describe('remote Extension soak runner', () => {
  it('defaults to twenty complete five-browser repetitions', () => {
    expect(parseRemoteExtensionSoakRepeats(undefined)).toBe(20)
    expect(parseRemoteExtensionSoakRepeats('')).toBe(20)
  })

  it.each(['0', '-1', '1.5', ' 2', '2 ', '101', '9007199254740992'])(
    'rejects unsafe repeat count %j',
    (value) => {
      expect(() => parseRemoteExtensionSoakRepeats(value)).toThrow()
    }
  )

  it('runs the regular threat-gated E2E command with Playwright repeat-each', () => {
    const spawn = vi.fn(() => ({ status: 0 }))

    expect(runRemoteExtensionSoak({ repeats: 3, spawn })).toEqual({
      repeats: 3,
      browserCases: 15,
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^pnpm(?:\.cmd)?$/u),
      ['test:e2e:remote-extension', '--repeat-each=3'],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })

  it('fails the soak when any repeated browser case fails', () => {
    expect(() =>
      runRemoteExtensionSoak({
        repeats: 2,
        spawn: () => ({ status: 1 }),
      })
    ).toThrow(/soak failed with exit code 1/)
  })
})
