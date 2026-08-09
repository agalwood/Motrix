import { describe, expect, it } from 'vitest'
import { normalizeSource, sourceUrlEquals } from './source-resolver'

describe('source-resolver', () => {
  // github
  it('normalizes github:owner/repo to origin-only URL', () => {
    expect(normalizeSource({ type: 'github', spec: 'owner/repo' })).toEqual({
      type: 'github',
      url: 'https://github.com/owner/repo',
    })
  })

  it('strips @tag from github spec', () => {
    expect(
      normalizeSource({ type: 'github', spec: 'acme/widget@v1.2.3' })
    ).toEqual({ type: 'github', url: 'https://github.com/acme/widget' })
  })

  it('rejects malformed github spec', () => {
    expect(() => normalizeSource({ type: 'github', spec: 'no-slash' })).toThrow(
      /invalid_github_spec/
    )
    expect(() =>
      normalizeSource({ type: 'github', spec: '/missing-owner' })
    ).toThrow(/invalid_github_spec/)
  })

  // url
  it('normalizes a deep URL to its origin', () => {
    expect(
      normalizeSource({
        type: 'url',
        url: 'https://cdn.example.com/path/foo-1.2.3.moext?token=abc',
      })
    ).toEqual({ type: 'url', url: 'https://cdn.example.com' })
  })

  it('preserves explicit non-default ports in origin', () => {
    expect(
      normalizeSource({ type: 'url', url: 'https://example.com:8443/x.moext' })
    ).toEqual({ type: 'url', url: 'https://example.com:8443' })
  })

  it('rejects non-http(s) URL schemes (e.g. file:)', () => {
    expect(() =>
      normalizeSource({ type: 'url', url: 'file:///tmp/foo.moext' })
    ).toThrow(/invalid_url/)
  })

  it('rejects malformed URL', () => {
    expect(() => normalizeSource({ type: 'url', url: 'not a url' })).toThrow(
      /invalid_url/
    )
  })

  // local
  it('normalizes local source to local:<hash>', () => {
    expect(
      normalizeSource({
        type: 'local',
        absPath: '/tmp/foo.moext',
        fileHash: 'a'.repeat(64),
      })
    ).toEqual({ type: 'local', url: `local:${'a'.repeat(64)}` })
  })

  it('rejects local source with non-64-hex file hash', () => {
    expect(() =>
      normalizeSource({
        type: 'local',
        absPath: '/tmp/foo.moext',
        fileHash: 'tooshort',
      })
    ).toThrow(/invalid_file_hash/)
  })

  // volume + env + builtin
  it('normalizes volume mount to volume:<path>', () => {
    expect(
      normalizeSource({ type: 'volume', containerPath: '/plugins/foo' })
    ).toEqual({ type: 'volume', url: 'volume:/plugins/foo' })
  })

  it('normalizes env install URL by passing through verbatim', () => {
    expect(
      normalizeSource({
        type: 'env',
        url: 'github:acme/widget@v1.2.3',
      })
    ).toEqual({ type: 'env', url: 'github:acme/widget@v1.2.3' })
  })

  it('normalizes builtin resource path with builtin: prefix', () => {
    expect(
      normalizeSource({ type: 'builtin', resourcePath: 'foo-builtin' })
    ).toEqual({ type: 'builtin', url: 'builtin:foo-builtin' })
  })

  // registry
  it('normalizes a registry source to registry:<pluginId>', () => {
    expect(
      normalizeSource({ type: 'registry', pluginId: 'acme.speed-boost' })
    ).toEqual({ type: 'registry', url: 'registry:acme.speed-boost' })
  })

  // sourceUrlEquals
  it('sourceUrlEquals compares exact url strings', () => {
    expect(
      sourceUrlEquals(
        { url: 'https://github.com/a/b' },
        { url: 'https://github.com/a/b' }
      )
    ).toBe(true)
    expect(
      sourceUrlEquals(
        { url: 'https://github.com/a/b' },
        { url: 'https://github.com/a/c' }
      )
    ).toBe(false)
  })
})
