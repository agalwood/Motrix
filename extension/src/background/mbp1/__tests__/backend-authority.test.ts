import { describe, expect, it } from 'vitest'
import {
  backendAuthorityKey,
  createRemoteBackendAuthority,
  LOCAL_BACKEND_AUTHORITY,
} from '@/background/mbp1/backend-authority'

function remote(endpointId: string, wsBase: string) {
  return createRemoteBackendAuthority({ endpointId, wsBase })
}

describe('BackendAuthority', () => {
  it('canonicalizes equivalent WSS bases to one authority and key', () => {
    const a = remote('server-a', 'wss://MOTRIX.Example:443/bridge///')
    const b = remote('server-a', 'wss://motrix.example/bridge')

    expect(a.kind).toBe('remote')
    expect(a.endpointId).toBe('server-a')
    expect(a.canonicalWsBase).toBe('wss://motrix.example/bridge')
    expect(backendAuthorityKey(a)).toBe(backendAuthorityKey(b))
  })

  it('accepts canonical WS while keeping its trust scope separate from WSS', () => {
    const ws = remote('server-a', 'WS://NAS.Local:80/bridge///')
    const wss = remote('server-a', 'wss://nas.local/bridge')

    expect(ws.canonicalWsBase).toBe('ws://nas.local/bridge')
    expect(backendAuthorityKey(ws)).not.toBe(backendAuthorityKey(wss))
  })

  it('changes scope when either endpoint id or canonical URL changes', () => {
    const original = remote('server-a', 'wss://motrix.example/bridge')
    const renamedId = remote('server-b', 'wss://motrix.example/bridge')
    const changedUrl = remote('server-a', 'wss://motrix.example/other')

    expect(backendAuthorityKey(original)).not.toBe(
      backendAuthorityKey(renamedId)
    )
    expect(backendAuthorityKey(original)).not.toBe(
      backendAuthorityKey(changedUrl)
    )
  })

  it('does not put a display name into authority scope', () => {
    const before = {
      id: 'server-a',
      name: 'Office Server',
      url: 'wss://motrix.example/bridge',
    }
    const after = { ...before, name: 'Renamed Server' }

    const beforeKey = backendAuthorityKey(remote(before.id, before.url))
    const afterKey = backendAuthorityKey(remote(after.id, after.url))
    expect(beforeKey).toBe(afterKey)
  })

  it('uses injective field encoding instead of a delimiter join', () => {
    const a = remote('a', 'wss://one.example/path|wss://two.example')
    const b = remote('a|wss://one.example/path', 'wss://two.example')

    // These deliberately collide under the tempting `id|url` encoding.
    expect(`${a.endpointId}|${a.canonicalWsBase}`).toBe(
      `${b.endpointId}|${b.canonicalWsBase}`
    )
    expect(backendAuthorityKey(a)).not.toBe(backendAuthorityKey(b))
  })

  it('domain-separates the local authority from every remote authority', () => {
    const localKey = backendAuthorityKey(LOCAL_BACKEND_AUTHORITY)
    const remoteKey = backendAuthorityKey(
      remote('local', 'wss://motrix.example')
    )

    expect(backendAuthorityKey(LOCAL_BACKEND_AUTHORITY)).toBe(localKey)
    expect(remoteKey).not.toBe(localKey)
  })

  it('rejects a structurally forged authority', () => {
    const forged = {
      kind: 'remote',
      endpointId: 'server-a',
      canonicalWsBase: 'wss://motrix.example',
    } as unknown as Parameters<typeof backendAuthorityKey>[0]

    expect(() => backendAuthorityKey(forged)).toThrow(
      'BackendAuthority must be created by its module factory'
    )
  })

  it('rejects a spread copy even when it copied the private brand', () => {
    const issued = remote('server-a', 'wss://motrix.example')
    const copied = { ...issued }

    expect(() => backendAuthorityKey(copied)).toThrow(
      'BackendAuthority must be created by its module factory'
    )
  })

  it('rejects a persisted and deserialized authority', () => {
    const issued = remote('server-a', 'wss://motrix.example')
    const restored = JSON.parse(JSON.stringify(issued)) as Parameters<
      typeof backendAuthorityKey
    >[0]

    expect(() => backendAuthorityKey(restored)).toThrow(
      'BackendAuthority must be created by its module factory'
    )
  })

  it.each([
    ['HTTP URL', 'https://motrix.example'],
    ['userinfo', 'wss://user:secret@motrix.example'],
    ['empty userinfo', 'wss://@motrix.example'],
    ['query', 'wss://motrix.example?token=legacy'],
    ['fragment', 'wss://motrix.example#bridge'],
    ['backslash', 'wss://motrix.example\\admin'],
    ['ASCII control', 'wss://motrix.example/\u0001admin'],
    ['embedded whitespace', 'wss://motrix.example/a b'],
    ['Unicode White_Space', 'wss://motrix.example/a\u0085b'],
    ['encoded slash', 'wss://motrix.example/%2fadmin'],
    ['encoded backslash', 'wss://motrix.example/%5Cadmin'],
    ['double-encoded slash', 'wss://motrix.example/%252fadmin'],
    ['split encoded backslash', 'wss://motrix.example/%25%35%63admin'],
    ['invalid percent encoding', 'wss://motrix.example/%zz'],
    ['leading whitespace', ' wss://motrix.example'],
    ['trailing whitespace', 'wss://motrix.example '],
    ['oversized URL', `wss://motrix.example/${'a'.repeat(4096)}`],
    ['malformed URL', 'not a URL'],
  ])('rejects %s input', (_label, wsBase) => {
    expect(() => remote('server-a', wsBase)).toThrow()
  })

  it.each(['', '   ', ' server-a', 'server-a ', '服务器'])(
    'rejects an invalid endpoint id %j',
    (endpointId) => {
      expect(() => remote(endpointId, 'wss://motrix.example')).toThrow()
    }
  )

  it('rejects oversized and control-bearing endpoint ids', () => {
    expect(() => remote('a'.repeat(129), 'wss://motrix.example')).toThrow()
    expect(() => remote('server\u0000a', 'wss://motrix.example')).toThrow()
  })
})
