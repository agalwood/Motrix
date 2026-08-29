import { parseDirectReplayRecipe } from '@shared/schemas/direct-replay-recipe'
import { describe, expect, it } from 'vitest'
import { buildDirectReplayRecipe } from './direct-replay-recipe'

describe('direct replay recipe', () => {
  it('builds a uri-only v1 recipe for a public direct download', () => {
    const recipe = buildDirectReplayRecipe({ connections: 8 })

    expect(recipe).toEqual({
      version: 1,
      connections: 8,
      requestModifiers: [],
      replayability: 'uri-only',
    })
    expect(parseDirectReplayRecipe({ directReplay: recipe })).toEqual(recipe)
  })

  it('treats a whitespace-only proxy as no request modifier', () => {
    expect(buildDirectReplayRecipe({ proxy: '  \t ' })).toEqual({
      version: 1,
      requestModifiers: [],
      replayability: 'uri-only',
    })
  })

  it('records only modifier categories and never their sensitive values', () => {
    const secrets = [
      'Bearer AUTH_SECRET',
      'session=COOKIE_SECRET',
      'http://user:PROXY_SECRET@proxy.example',
      '/tmp/COOKIE_JAR_SECRET.txt',
    ]
    const recipe = buildDirectReplayRecipe({
      headers: {
        Authorization: secrets[0] ?? '',
        Cookie: secrets[1] ?? '',
      },
      proxy: secrets[2],
      extraEngineOptions: { 'load-cookies': secrets[3] ?? '' },
    })

    expect(recipe).toEqual({
      version: 1,
      requestModifiers: ['headers', 'proxy', 'extraEngineOptions'],
      replayability: 'requires-credentials',
    })
    const serialized = JSON.stringify(recipe)
    for (const secret of secrets) expect(serialized).not.toContain(secret)
  })

  it('records an unsafe ambient engine profile without persisting its values', () => {
    expect(buildDirectReplayRecipe({}, true)).toEqual({
      version: 1,
      requestModifiers: ['engineGlobalOptions'],
      replayability: 'requires-credentials',
    })
  })

  it('accepts a bounded non-secret resource validator on a uri-only recipe', () => {
    const recipe = {
      ...buildDirectReplayRecipe({ connections: 4 }),
      resourceValidator: {
        kind: 'strong-etag' as const,
        value: '"release-v1"',
        contentLength: 4096,
        capturedAt: 7,
      },
    }

    expect(parseDirectReplayRecipe({ directReplay: recipe })).toEqual(recipe)
  })

  it.each([
    ['missing recipe', {}],
    ['unknown version', { directReplay: { version: 2 } }],
    [
      'unknown field',
      {
        directReplay: {
          version: 1,
          requestModifiers: [],
          replayability: 'uri-only',
          authorization: 'secret',
        },
      },
    ],
    [
      'inconsistent replayability',
      {
        directReplay: {
          version: 1,
          requestModifiers: ['headers'],
          replayability: 'uri-only',
        },
      },
    ],
    [
      'duplicate modifiers',
      {
        directReplay: {
          version: 1,
          requestModifiers: ['proxy', 'proxy'],
          replayability: 'requires-credentials',
        },
      },
    ],
    [
      'weak ETag validator',
      {
        directReplay: {
          version: 1,
          requestModifiers: [],
          replayability: 'uri-only',
          resourceValidator: {
            kind: 'strong-etag',
            value: 'W/"release-v1"',
            capturedAt: 7,
          },
        },
      },
    ],
  ])('treats %s as non-replayable', (_label, payload) => {
    expect(parseDirectReplayRecipe(payload)).toBeNull()
  })
})
