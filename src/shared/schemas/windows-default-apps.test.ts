import { describe, expect, it } from 'vitest'
import { WindowsStartupTaskResponseSchema } from './auto-launch'
import {
  WindowsAssociationsRequestSchema,
  WindowsAssociationsResponseSchema,
  WindowsAssociationsResultSchema,
  WindowsDefaultAssociationsSchema,
  WindowsMainAppAumidSchema,
} from './windows-default-apps'

const success = {
  version: 1,
  ok: true,
  packageIdentityPresent: true,
  mainAppAumid: 'Motrix.Store.Test_8wekyb3d8bbwe!Motrix',
  torrent: true,
  magnet: null,
}

describe('packaged Windows association schemas', () => {
  it('accepts only the fixed read operation and no caller-provided identity', () => {
    const request = { version: 1, op: 'associations_query' }
    expect(WindowsAssociationsRequestSchema.parse(request)).toEqual(request)
    for (const invalid of [
      { ...request, version: 2 },
      { ...request, op: 'startup_enable' },
      { ...request, mainAppAumid: success.mainAppAumid },
      { ...request, association: '.exe' },
    ]) {
      expect(WindowsAssociationsRequestSchema.safeParse(invalid).success).toBe(
        false
      )
    }
  })

  it.each([
    '',
    'Motrix',
    'Motrix.Store.Test_8wekyb3d8bbwe!Helper',
    'Motrix.Store.Test_8wekyb3d8bbwe!Motrix&other=app',
    'Motrix.Store.Test_8wekyb3d8bbwe!Motrix\n',
    'Mo_8wekyb3d8bbwe!Motrix',
    `${'a'.repeat(51)}_8wekyb3d8bbwe!Motrix`,
    'Motrix_8wekyb3d8bbwi!Motrix',
    'Motrix_8wekyb3d8bbwe0!Motrix',
  ])('rejects malformed main AUMID %j', (aumid) => {
    expect(WindowsMainAppAumidSchema.safeParse(aumid).success).toBe(false)
  })

  it('accepts the OS-preserved identity casing and independent unknown values', () => {
    expect(WindowsMainAppAumidSchema.parse('Motrix_8WEKYB3D8BBWE!Motrix')).toBe(
      'Motrix_8WEKYB3D8BBWE!Motrix'
    )
    expect(WindowsAssociationsResponseSchema.parse(success)).toEqual(success)
  })

  it.each([
    { ...success, ok: 'true' },
    { ...success, packageIdentityPresent: false },
    { ...success, torrent: 'true' },
    { ...success, magnet: undefined },
    { ...success, mainAppAumid: null },
    { ...success, scope: 'user' },
  ])('rejects malformed native success %j', (result) => {
    expect(WindowsAssociationsResponseSchema.safeParse(result).success).toBe(
      false
    )
  })

  it('keeps operation responses and adapter failures separate on the wire', () => {
    const startup = {
      version: 1,
      ok: true,
      taskId: 'MotrixStartup',
      state: 'enabled',
      packageIdentityPresent: true,
    }
    expect(WindowsAssociationsResponseSchema.safeParse(startup).success).toBe(
      false
    )
    expect(WindowsStartupTaskResponseSchema.safeParse(success).success).toBe(
      false
    )
    expect(
      WindowsStartupTaskResponseSchema.safeParse({
        version: 1,
        ok: false,
        code: 'main_app_unavailable',
      }).success
    ).toBe(false)
    expect(
      WindowsAssociationsResponseSchema.safeParse({
        version: 1,
        ok: false,
        code: 'task_unavailable',
      }).success
    ).toBe(false)
    const adapter = { version: 1, ok: false, code: 'helper_timeout' }
    expect(WindowsAssociationsResponseSchema.safeParse(adapter).success).toBe(
      false
    )
    expect(WindowsAssociationsResultSchema.parse(adapter)).toEqual(adapter)
  })

  it('does not allow a packaged status to claim a traditional registration', () => {
    const packaged = {
      authority: 'windows-package',
      supported: true,
      registered: null,
      scope: null,
      mainAppAumid: success.mainAppAumid,
      torrent: true,
      magnet: false,
    }
    expect(WindowsDefaultAssociationsSchema.parse(packaged)).toEqual(packaged)
    for (const invalid of [
      { ...packaged, registered: true },
      { ...packaged, scope: 'user' },
      { ...packaged, mainAppAumid: null },
      { ...packaged, authority: 'other' },
      { ...packaged, supported: false },
    ]) {
      expect(WindowsDefaultAssociationsSchema.safeParse(invalid).success).toBe(
        false
      )
    }
  })
})
