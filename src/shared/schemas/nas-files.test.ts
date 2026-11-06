import { describe, expect, it } from 'vitest'
import { synologyFileStationUrl } from './nas-files'
import {
  nasPackageSettingsSchema,
  synologyConnectionUrls,
} from './nas-settings'

describe('NAS host navigation and settings contracts', () => {
  it('roundtrips Unicode and URL punctuation without introducing another host or query field', () => {
    const path = '/volume1/motrix/中文 & #+% folder'
    const url = new URL(synologyFileStationUrl(path), 'https://nas.test:5001')
    expect(url.origin).toBe('https://nas.test:5001')
    expect([...url.searchParams.keys()]).toEqual(['launchApp', 'launchParam'])
    expect(url.searchParams.get('launchApp')).toBe(
      'SYNO.SDS.App.FileStation3.Instance'
    )
    expect(
      new URLSearchParams(url.searchParams.get('launchParam') ?? '').get(
        'openfile'
      )
    ).toBe('/motrix/中文 & #+% folder/')
    for (const path of [
      '/etc',
      '//evil.test/share',
      '/volume1/motrix/../private',
      '/volume1/motrix\n',
    ])
      expect(() => synologyFileStationUrl(path)).toThrow()
  })
  it('derives fixed same-origin endpoints and rejects credentials or non-origin inputs', () => {
    expect(synologyConnectionUrls('https://nas.test:5001')).toEqual({
      operatorUrl: 'https://nas.test:5001/motrix/',
      extensionUrl: 'wss://nas.test:5001/motrix/bridge',
    })
    for (const origin of [
      'https://user:secret@nas.test',
      'https://nas.test/path',
      'javascript:alert(1)',
    ])
      expect(() => synologyConnectionUrls(origin)).toThrow()
  })
  it('rejects ambiguous folder grants and invalid ports before persistence', () => {
    const settings = {
      roots: ['/volume1/motrix'],
      clientPort: 16802,
      extensionUrl: '',
      operatorUrl: '',
      allowHttp: false,
    }
    for (const roots of [
      [],
      ['/'],
      ['relative'],
      ['/volume1/motrix/..'],
      ['/volume1/motrix', '/volume1/motrix'],
      ['/volume1/motrix\0'],
    ])
      expect(
        nasPackageSettingsSchema.safeParse({ ...settings, roots }).success
      ).toBe(false)
    expect(
      nasPackageSettingsSchema.safeParse({ ...settings, clientPort: 65536 })
        .success
    ).toBe(false)
  })
})
