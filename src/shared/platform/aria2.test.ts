import { describe, expect, it } from 'vitest'
import { aria2BinaryName } from './aria2'

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
