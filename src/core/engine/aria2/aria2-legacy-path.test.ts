import { describe, expect, it } from 'vitest'
import { legacyWirePath } from './aria2-legacy-path'

describe('legacy native engine paths', () => {
  it('keeps POSIX keys and converts canonical Windows Unicode paths', () => {
    expect(legacyWirePath('/confirmed/下载/file.bin', 'darwin')).toBe(
      '/confirmed/下载/file.bin'
    )
    expect(legacyWirePath('C:\\Users\\name\\下载\\file.bin', 'win32')).toBe(
      'C:/Users/name/下载/file.bin'
    )
    const long = `D:\\${'nested\\'.repeat(40)}file.bin`
    expect(legacyWirePath(long, 'win32')).toBe(long.replaceAll('\\', '/'))
  })

  it.each([
    'C:relative.bin',
    '\\\\server\\share\\file.bin',
    '\\\\?\\C:\\file.bin',
    'C:\\dir\\..\\file.bin',
    'C:\\dir\\file.bin:stream',
    'C:\\dir\\file.bin.',
    'C:\\dir\\file.bin ',
    'C:\\dir\\CON.txt',
    'C:\\dir\\LPT1',
    'c:\\dir\\file.bin',
    'C:\\dir\\bad\u0000.bin',
  ])('refuses ambiguous Windows identity %j', (value) => {
    expect(() => legacyWirePath(value, 'win32')).toThrow()
  })
})
