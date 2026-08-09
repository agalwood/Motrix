import { describe, expect, it } from 'vitest'
import { aria2BinaryName, bundledAria2Path } from './aria2'

describe('aria2BinaryName', () => {
  it('returns aria2c.exe on win32', () => {
    expect(aria2BinaryName('win32')).toBe('aria2c.exe')
  })
  it('returns aria2c on darwin', () => {
    expect(aria2BinaryName('darwin')).toBe('aria2c')
  })
  it('returns aria2c on linux', () => {
    expect(aria2BinaryName('linux')).toBe('aria2c')
  })
})

describe('bundledAria2Path', () => {
  it('joins extraDir/platform/arch/aria2c for darwin', () => {
    expect(bundledAria2Path('/fake/extra', 'darwin', 'arm64')).toBe(
      '/fake/extra/darwin/arm64/aria2c'
    )
  })
  it('appends .exe suffix for win32', () => {
    expect(bundledAria2Path('/fake/extra', 'win32', 'x64')).toBe(
      '/fake/extra/win32/x64/aria2c.exe'
    )
  })
  it('joins extraDir/platform/arch/aria2c for linux', () => {
    expect(bundledAria2Path('/fake/extra', 'linux', 'x64')).toBe(
      '/fake/extra/linux/x64/aria2c'
    )
  })
})
