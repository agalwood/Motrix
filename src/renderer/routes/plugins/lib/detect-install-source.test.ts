import { describe, expect, it } from 'vitest'
import { detectInstallSource } from './detect-install-source'

describe('detectInstallSource', () => {
  it('returns null for empty input', () => {
    expect(detectInstallSource('')).toBeNull()
    expect(detectInstallSource('   ')).toBeNull()
  })

  it('detects .moext (case-insensitive) as local', () => {
    expect(detectInstallSource('plugin.moext')).toBe('local')
    expect(detectInstallSource('/abs/plugin.MOEXT')).toBe('local')
  })

  it('detects http(s) URLs as url', () => {
    expect(detectInstallSource('http://example.com/x')).toBe('url')
    expect(detectInstallSource('https://x.com/p.moext')).toBe('local')
  })

  it('detects owner/repo shorthand as github', () => {
    expect(detectInstallSource('motrix/plugin-x')).toBe('github')
  })

  it('detects owner/repo@tag as github', () => {
    expect(detectInstallSource('motrix/plugin-x@v1.2.3')).toBe('github')
  })

  it('returns null for unrecognized text', () => {
    expect(detectInstallSource('just some words')).toBeNull()
  })
})
