import { describe, expect, it, vi } from 'vitest'
import { probeWindowsPackageReadonlyIntegration } from './windows-package-readonly-probe'

const options = {
  sourceCommit: 'a'.repeat(40),
  familyName: 'Motrix.Store.Test_cfpch8pkrx9m2',
  resourcesPath: '/test/resources',
}
const startup = {
  version: 1,
  ok: true,
  packageIdentityPresent: true,
  taskId: 'MotrixStartup',
  state: 'disabled',
}
const associations = {
  version: 1,
  ok: true,
  packageIdentityPresent: true,
  mainAppAumid: `${options.familyName}!Motrix`,
  torrent: null,
  magnet: false,
}

describe('test-profile main child read-only observation', () => {
  it('serially queries before/defaults/after without mutation and keeps unknown defaults', async () => {
    const calls: string[] = []
    const result = await probeWindowsPackageReadonlyIntegration(options, {
      requestStartup: async (op) => {
        calls.push(op)
        return startup
      },
      queryAssociations: async () => {
        calls.push('associations_query')
        return associations
      },
    })
    expect(calls).toEqual([
      'startup_query',
      'associations_query',
      'startup_query',
    ])
    expect(result).toMatchObject({
      sourceCommit: options.sourceCommit,
      ok: true,
      observation: {
        startupStateBefore: 'disabled',
        startupStateAfter: 'disabled',
        torrent: null,
        magnet: false,
        readOnlyVerified: true,
      },
    })
  })
  it('rejects a different package AUMID before issuing another query', async () => {
    const requestStartup = vi.fn().mockResolvedValue(startup)
    const result = await probeWindowsPackageReadonlyIntegration(options, {
      requestStartup,
      queryAssociations: async () => ({
        ...associations,
        mainAppAumid: 'Other.Package_cfpch8pkrx9m2!Motrix',
      }),
    })
    expect(result).toMatchObject({
      ok: false,
      operation: 'associations',
      code: 'identity_mismatch',
    })
    expect(requestStartup).toHaveBeenCalledOnce()
  })
  it('does not claim unchanged startup when another actor changes it', async () => {
    const requestStartup = vi
      .fn()
      .mockResolvedValueOnce(startup)
      .mockResolvedValueOnce({ ...startup, state: 'disabled_by_user' })
    expect(
      await probeWindowsPackageReadonlyIntegration(options, {
        requestStartup,
        queryAssociations: async () => associations,
      })
    ).toMatchObject({ ok: false, code: 'startup_state_changed' })
  })
  it('preserves only fixed failures and drops exception text or malformed data', async () => {
    const queryAssociations = vi.fn()
    for (const reply of [
      { version: 1, ok: false, code: 'helper_unavailable' },
      { ...startup, taskId: true },
    ]) {
      const result = await probeWindowsPackageReadonlyIntegration(options, {
        requestStartup: async () => reply,
        queryAssociations,
      })
      expect(result).toMatchObject({ ok: false, operation: 'startup-before' })
    }
    expect(queryAssociations).not.toHaveBeenCalled()
    const result = await probeWindowsPackageReadonlyIntegration(options, {
      requestStartup: async () => {
        throw new Error('private-fixture-data')
      },
      queryAssociations,
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_response' })
    expect(JSON.stringify(result)).not.toContain('private-fixture-data')
  })
})
