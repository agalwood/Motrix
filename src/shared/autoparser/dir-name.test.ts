import { describe, expect, it } from 'vitest'
import { deriveAutoparserDirName, joinParentDir } from './dir-name'

describe('deriveAutoparserDirName', () => {
  it('derives an owner_model name from a ModelScope file listing page', () => {
    expect(
      deriveAutoparserDirName(
        'https://www.modelscope.cn/models/unsloth/Qwen3.8-27B-GGUF/files'
      )
    ).toBe('unsloth_Qwen3.8-27B-GGUF')
  })

  it('derives a decoded, capitalized name from an anchor-fragment page', () => {
    expect(
      deriveAutoparserDirName(
        'https://www.openeuler.openatom.cn/zh/download/#openEuler%2024.03%20LTS%20SP4'
      )
    ).toBe('OpenEuler 24.03 LTS SP4')
  })

  it('prefers the hash fragment over the path when both exist', () => {
    expect(
      deriveAutoparserDirName('https://example.com/downloads/#Product%20v2.5')
    ).toBe('Product v2.5')
  })

  it('strips trailing noise segments and takes the last two', () => {
    expect(
      deriveAutoparserDirName(
        'https://huggingface.co/models/owner/my-model/files'
      )
    ).toBe('owner_my-model')
  })

  it('falls back to the last meaningful segment when only one remains', () => {
    expect(
      deriveAutoparserDirName('https://example.com/downloads/KeePass-2.47')
    ).toBe('KeePass-2.47')
  })

  it('replaces forbidden characters with underscores and trims edges', () => {
    expect(deriveAutoparserDirName('https://example.com/a b:c/d?e')).toBe(
      'a b_c_d'
    )
    // Leading/trailing dots are trimmed so no hidden directory is created.
    expect(deriveAutoparserDirName('https://example.com/..hidden..')).toBe(
      'hidden'
    )
  })

  it('avoids Windows reserved device names', () => {
    expect(deriveAutoparserDirName('https://example.com/CON')).toBe('_CON')
  })

  it('falls back to the original tail when the whole path is noise', () => {
    const name = deriveAutoparserDirName(
      'https://example.com/zh/download/index.html'
    )
    expect(name.length).toBeGreaterThan(0)
    // Never leaks a separator or path-special character into the folder name.
    expect(name).not.toMatch(/[/\\:?#]+/)
  })

  it('returns an empty string for an empty / non-derivable URL', () => {
    expect(deriveAutoparserDirName('')).toBe('')
    expect(deriveAutoparserDirName('https://example.com/')).toBe('')
  })
})

describe('joinParentDir', () => {
  it('joins with the parent separator flavour', () => {
    expect(joinParentDir('C:\\users\\xiaxq\\downloads', 'unsloth_x')).toBe(
      'C:\\users\\xiaxq\\downloads\\unsloth_x'
    )
    expect(joinParentDir('/downloads', 'repo')).toBe('/downloads/repo')
  })

  it('trims trailing separators from the parent', () => {
    expect(joinParentDir('C:\\downloads\\', 'sub')).toBe('C:\\downloads\\sub')
    expect(joinParentDir('/downloads/', 'sub')).toBe('/downloads/sub')
  })

  it('returns the parent unchanged for an empty child', () => {
    expect(joinParentDir('/downloads', '')).toBe('/downloads')
  })
})
