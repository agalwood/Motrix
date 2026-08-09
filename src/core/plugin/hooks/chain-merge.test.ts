import { describe, expect, it } from 'vitest'
import { mergeChain } from './chain-merge'
import type { RoleBand } from './role-band'
import type { StagedHttpPatch } from './staged-effects'

// ── helpers ──────────────────────────────────────────────────────────────────

function entry(pluginId: string, role: RoleBand, patch: StagedHttpPatch) {
  return { pluginId, role, patch }
}

const BASE_INPUT = {
  uris: ['https://origin.example.com/file.zip'],
  headers: [] as { name: string; value: string }[],
}

// ── 1. empty plugin list ──────────────────────────────────────────────────────

describe('mergeChain', () => {
  it('empty plugin list returns userInput unchanged with empty contributors', () => {
    const result = mergeChain(
      {
        uris: ['https://a.example.com/'],
        headers: [{ name: 'X-Foo', value: 'a' }],
      },
      []
    )
    expect(result.uris).toEqual(['https://a.example.com/'])
    expect(result.headers).toEqual([{ name: 'X-Foo', value: 'a' }])
    expect(result.proxy).toBeUndefined()
    expect(result.contributors).toEqual({
      headers: [],
      proxy: undefined,
      uris: undefined,
    })
  })

  // ── 2. user-input header anchor (case-insensitive) ─────────────────────────

  it('user-input header X-Foo survives plugin patch with matching lowercase name', () => {
    const result = mergeChain(
      { ...BASE_INPUT, headers: [{ name: 'X-Foo', value: 'a' }] },
      [
        entry('plug.enrich', 'enrich', {
          headers: [{ name: 'x-foo', value: 'b' }],
        }),
      ]
    )
    // user value must survive
    expect(result.headers).toContainEqual({ name: 'X-Foo', value: 'a' })
    // plugin override must be absent
    expect(result.headers).not.toContainEqual({ name: 'x-foo', value: 'b' })
  })

  it('user-input header anchor is case-insensitive (mixed-case plugin name rejected)', () => {
    const result = mergeChain(
      {
        ...BASE_INPUT,
        headers: [{ name: 'Authorization', value: 'Bearer token' }],
      },
      [
        entry('plug.enrich', 'enrich', {
          headers: [{ name: 'AUTHORIZATION', value: 'Bearer hack' }],
        }),
      ]
    )
    expect(result.headers).toHaveLength(1)
    expect(result.headers[0]).toEqual({
      name: 'Authorization',
      value: 'Bearer token',
    })
  })

  // ── 3. two plugins patch same header: later-band wins ─────────────────────

  it('later-band plugin value overrides earlier-band plugin for same header', () => {
    const result = mergeChain(BASE_INPUT, [
      entry('plug.enrich', 'enrich', {
        headers: [{ name: 'X-Bar', value: 'enrich-val' }],
      }),
      entry('plug.audit', 'audit', {
        headers: [{ name: 'X-Bar', value: 'audit-val' }],
      }),
    ])
    expect(result.headers).toContainEqual({ name: 'X-Bar', value: 'audit-val' })
    expect(result.headers).not.toContainEqual({
      name: 'X-Bar',
      value: 'enrich-val',
    })
  })

  // ── 4. same band, two plugin ids: lexical order (later id wins) ───────────

  it('same band two plugins: later plugin id (lexical) wins for same header', () => {
    // 'plug.z' > 'plug.a' lexically, so 'plug.z' wins
    const result = mergeChain(BASE_INPUT, [
      entry('plug.a', 'enrich', {
        headers: [{ name: 'X-Token', value: 'val-a' }],
      }),
      entry('plug.z', 'enrich', {
        headers: [{ name: 'X-Token', value: 'val-z' }],
      }),
    ])
    expect(result.headers).toContainEqual({ name: 'X-Token', value: 'val-z' })
    expect(result.headers).not.toContainEqual({
      name: 'X-Token',
      value: 'val-a',
    })
  })

  // ── 5. proxy: user input wins ─────────────────────────────────────────────

  it('proxy: user input wins over any plugin patch', () => {
    const result = mergeChain(
      { ...BASE_INPUT, proxy: 'http://user-proxy.example.com' },
      [
        entry('plug.enrich', 'enrich', {
          proxy: 'http://plugin-proxy.example.com',
        }),
      ]
    )
    expect(result.proxy).toBe('http://user-proxy.example.com')
    expect(result.contributors.proxy).toBeUndefined()
  })

  // ── 6. proxy: absent → last-band plugin's proxy ───────────────────────────

  it('proxy: absent in user input → last-band plugin proxy wins', () => {
    const result = mergeChain(BASE_INPUT, [
      entry('plug.resolve', 'resolve', {
        proxy: 'http://resolve-proxy.example.com',
      }),
      entry('plug.enrich', 'enrich', {
        proxy: 'http://enrich-proxy.example.com',
      }),
    ])
    // 'enrich' is later band than 'resolve'
    expect(result.proxy).toBe('http://enrich-proxy.example.com')
    expect(result.contributors.proxy).toBe('plug.enrich')
  })

  it('proxy: absent in user input → same band, later id wins', () => {
    const result = mergeChain(BASE_INPUT, [
      entry('plug.a', 'enrich', { proxy: 'http://proxy-a.example.com' }),
      entry('plug.z', 'enrich', { proxy: 'http://proxy-z.example.com' }),
    ])
    expect(result.proxy).toBe('http://proxy-z.example.com')
    expect(result.contributors.proxy).toBe('plug.z')
  })

  // ── 7. audit-band patches are tolerated without breaking the algorithm ────

  it('audit-band patch with headers does not throw and produces deterministic output', () => {
    expect(() =>
      mergeChain(BASE_INPUT, [
        entry('plug.audit', 'audit', {
          headers: [{ name: 'X-Audit', value: 'logged' }],
        }),
      ])
    ).not.toThrow()
    const result = mergeChain(BASE_INPUT, [
      entry('plug.audit', 'audit', {
        headers: [{ name: 'X-Audit', value: 'logged' }],
      }),
    ])
    expect(result.headers).toContainEqual({ name: 'X-Audit', value: 'logged' })
  })

  // ── 8. uris: last plugin that set uris wins; contributors.uris reports id ──

  it('uris: last plugin that set uris wins, contributors.uris is its id', () => {
    const result = mergeChain(BASE_INPUT, [
      entry('plug.resolve', 'resolve', { uris: ['https://cdn1.example.com/'] }),
      entry('plug.enrich', 'enrich', { uris: ['https://cdn2.example.com/'] }),
    ])
    expect(result.uris).toEqual(['https://cdn2.example.com/'])
    expect(result.contributors.uris).toBe('plug.enrich')
  })

  it('uris: no plugin sets uris → user input survives, contributors.uris is undefined', () => {
    const result = mergeChain(
      { ...BASE_INPUT, uris: ['https://origin.example.com/'] },
      [entry('plug.enrich', 'enrich', { filename: 'renamed.zip' })]
    )
    expect(result.uris).toEqual(['https://origin.example.com/'])
    expect(result.contributors.uris).toBeUndefined()
  })

  // ── 9. connections: later-band/later-id wins ──────────────────────────────

  it('connections: later-band plugin wins', () => {
    const result = mergeChain(BASE_INPUT, [
      entry('plug.resolve', 'resolve', { connections: 4 }),
      entry('plug.enrich', 'enrich', { connections: 8 }),
    ])
    expect(result.connections).toBe(8)
  })

  it('connections: same band, later id wins', () => {
    const result = mergeChain(BASE_INPUT, [
      entry('plug.a', 'enrich', { connections: 4 }),
      entry('plug.z', 'enrich', { connections: 16 }),
    ])
    expect(result.connections).toBe(16)
  })

  // ── 10. filename: later-band/later-id wins ────────────────────────────────

  it('filename: later-band plugin wins', () => {
    const result = mergeChain(BASE_INPUT, [
      entry('plug.resolve', 'resolve', { filename: 'resolve-name.zip' }),
      entry('plug.enrich', 'enrich', { filename: 'enrich-name.zip' }),
    ])
    expect(result.filename).toBe('enrich-name.zip')
  })

  it('filename: same band, later id wins', () => {
    const result = mergeChain(BASE_INPUT, [
      entry('plug.a', 'enrich', { filename: 'alpha.zip' }),
      entry('plug.z', 'enrich', { filename: 'zeta.zip' }),
    ])
    expect(result.filename).toBe('zeta.zip')
  })

  // ── 11. multiple non-conflicting headers from different plugins all present ─

  it('multiple distinct plugin headers are all present in output', () => {
    const result = mergeChain(BASE_INPUT, [
      entry('plug.a', 'enrich', {
        headers: [{ name: 'X-Source', value: 'a' }],
      }),
      entry('plug.b', 'enrich', {
        headers: [{ name: 'X-Mirror', value: 'b' }],
      }),
    ])
    expect(result.headers).toContainEqual({ name: 'X-Source', value: 'a' })
    expect(result.headers).toContainEqual({ name: 'X-Mirror', value: 'b' })
  })

  // ── 12. contributors.headers lists all unique plugin ids that contributed ──

  it('contributors.headers lists plugin ids in band+id order that contributed headers', () => {
    const result = mergeChain(BASE_INPUT, [
      entry('plug.z', 'enrich', { headers: [{ name: 'X-Z', value: 'z' }] }),
      entry('plug.a', 'resolve', { headers: [{ name: 'X-A', value: 'a' }] }),
    ])
    // resolve (band 1) comes before enrich (band 2)
    expect(result.contributors.headers).toEqual(['plug.a', 'plug.z'])
  })

  it('contributors.headers does not duplicate a plugin id when it contributes multiple headers', () => {
    const result = mergeChain(BASE_INPUT, [
      entry('plug.a', 'enrich', {
        headers: [
          { name: 'X-One', value: '1' },
          { name: 'X-Two', value: '2' },
        ],
      }),
    ])
    expect(result.contributors.headers).toEqual(['plug.a'])
  })

  // ── 13. user-input fields (non-header) are preserved when no plugin patches ─

  it('userInput filename/connections/proxy survive when no plugin patches those fields', () => {
    const result = mergeChain(
      {
        uris: ['https://x.example.com/'],
        filename: 'user.zip',
        connections: 2,
        headers: [],
        proxy: 'http://user-proxy.example.com',
      },
      [
        entry('plug.enrich', 'enrich', {
          headers: [{ name: 'X-Extra', value: 'v' }],
        }),
      ]
    )
    expect(result.filename).toBe('user.zip')
    expect(result.connections).toBe(2)
    expect(result.proxy).toBe('http://user-proxy.example.com')
  })
})
