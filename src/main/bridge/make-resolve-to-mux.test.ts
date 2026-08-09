import { describe, expect, it, vi } from 'vitest'
import { makeResolveToMux } from './index'

// Build a fake registry entry shaped like PluginRegistry.entries() rows:
// { manifest, origin, enabled }. A site-resolver contributes to the mux seam
// only when it declares a PUBLIC command whose id is `${manifest.id}.resolve`
// (the resolve-command marker); pass `resolveCommand: false` to omit it.
function plugin(spec: {
  id: string
  hostPermissions?: string[]
  categories?: string[]
  enabled?: boolean
  origin?: 'builtin' | 'community'
  resolveCommand?: boolean
}) {
  const commands =
    spec.resolveCommand === false
      ? []
      : [
          {
            id: `${spec.id}.resolve`,
            title: 'resolve',
            public: true,
            argsSchema: {},
            resultSchema: {},
          },
        ]
  return {
    manifest: {
      id: spec.id,
      categories: spec.categories ?? ['site-resolver'],
      hostPermissions: spec.hostPermissions ?? [],
      contributes: { commands },
    },
    origin: spec.origin ?? 'community',
    enabled: spec.enabled ?? true,
  }
}

function fakeRegistry(...plugins: ReturnType<typeof plugin>[]) {
  return { entries: () => plugins } as any
}

const BILI = 'https://www.bilibili.com/video/BV1xx411c7mD'
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

describe('makeResolveToMux — generalized multi-resolver routing', () => {
  it('routes to an enabled site-resolver that declares <id>.resolve and whose hostPermissions admit the url', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({
      kind: 'mux',
      video: { url: 'https://cdn/v.m4s', headers: { Referer: 'https://x' } },
      audio: { url: 'https://cdn/a.m4s' },
      container: 'mp4',
      title: 'T',
    })
    const pluginHost = {
      activate: vi.fn().mockResolvedValue(undefined),
      invokeCommand,
    } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'community.bilibili-resolver',
          hostPermissions: ['*://*.bilibili.com/*'],
        })
      ),
      pluginHost
    )
    expect(await resolve(BILI)).toEqual({
      videoUrl: 'https://cdn/v.m4s',
      audioUrl: 'https://cdn/a.m4s',
      container: 'mp4',
      headers: { Referer: 'https://x' },
      title: 'T',
    })
    expect(pluginHost.activate).toHaveBeenCalledWith(
      'community.bilibili-resolver'
    )
    expect(invokeCommand).toHaveBeenCalledWith(
      'community.bilibili-resolver',
      'community.bilibili-resolver.resolve',
      { url: BILI }
    )
  })

  // Regression lock (carried from A1): motrix.scraper-hook is a builtin
  // 'site-resolver' with hostPermissions ['*://*/*'] and NO resolve command.
  // Routing keyed off the resolve-command marker (not the site-resolver
  // category) must NEVER invoke it, so a broad co-installed site-resolver
  // cannot collapse the seam to match-everything.
  it('never routes to a broad site-resolver that has no <id>.resolve command', async () => {
    const invokeCommand = vi.fn()
    const pluginHost = { activate: vi.fn(), invokeCommand } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'motrix.scraper-hook',
          hostPermissions: ['*://*/*'],
          origin: 'builtin',
          resolveCommand: false,
        })
      ),
      pluginHost
    )
    expect(await resolve('https://example.com/file.zip')).toBeNull()
    expect(await resolve(BILI)).toBeNull()
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('ignores a plugin that declares <id>.resolve but is not categorized site-resolver', async () => {
    const invokeCommand = vi.fn()
    const pluginHost = { activate: vi.fn(), invokeCommand } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'community.thing',
          categories: ['post-action'],
          hostPermissions: ['*://*.bilibili.com/*'],
        })
      ),
      pluginHost
    )
    expect(await resolve(BILI)).toBeNull()
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('skips a disabled resolver even if its hostPermissions match', async () => {
    const invokeCommand = vi.fn()
    const pluginHost = { activate: vi.fn(), invokeCommand } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'community.bilibili-resolver',
          hostPermissions: ['*://*.bilibili.com/*'],
          enabled: false,
        })
      ),
      pluginHost
    )
    expect(await resolve(BILI)).toBeNull()
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('returns null when no enabled resolver hostPermissions admit the url', async () => {
    const invokeCommand = vi.fn()
    const pluginHost = { activate: vi.fn(), invokeCommand } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'community.bilibili-resolver',
          hostPermissions: ['*://*.bilibili.com/*'],
        })
      ),
      pluginHost
    )
    expect(await resolve(YT)).toBeNull()
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('empty official resolvable set: with only a stripped resolver (no hostPermissions), nothing is routed', async () => {
    const invokeCommand = vi.fn()
    const pluginHost = { activate: vi.fn(), invokeCommand } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'motrix.url-resolver',
          hostPermissions: [],
          origin: 'builtin',
        })
      ),
      pluginHost
    )
    expect(await resolve(BILI)).toBeNull()
    expect(await resolve(YT)).toBeNull()
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('tries builtin-origin resolvers before community and falls through a null result to the next', async () => {
    const invokeCommand = vi.fn(async (id: string) =>
      id === 'community.b-resolver'
        ? {
            kind: 'mux',
            video: { url: 'https://c/v' },
            audio: { url: 'https://c/a' },
            container: 'mp4',
          }
        : null
    )
    const pluginHost = {
      activate: vi.fn().mockResolvedValue(undefined),
      invokeCommand,
    } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'community.b-resolver',
          hostPermissions: ['*://*.site.com/*'],
          origin: 'community',
        }),
        plugin({
          id: 'motrix.a-resolver',
          hostPermissions: ['*://*.site.com/*'],
          origin: 'builtin',
        })
      ),
      pluginHost
    )
    expect(await resolve('https://www.site.com/x')).toEqual({
      videoUrl: 'https://c/v',
      audioUrl: 'https://c/a',
      container: 'mp4',
    })
    // builtin tried first (returned null), then community produced the mux
    expect(invokeCommand.mock.calls.map((c) => c[0])).toEqual([
      'motrix.a-resolver',
      'community.b-resolver',
    ])
  })

  it('falls through to the next resolver when one throws', async () => {
    const invokeCommand = vi.fn(async (id: string) => {
      if (id === 'motrix.a-resolver') throw new Error('boom')
      return {
        kind: 'mux',
        video: { url: 'https://c/v' },
        audio: { url: 'https://c/a' },
        container: 'mkv',
      }
    })
    const pluginHost = {
      activate: vi.fn().mockResolvedValue(undefined),
      invokeCommand,
    } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'community.b-resolver',
          hostPermissions: ['*://*.site.com/*'],
          origin: 'community',
        }),
        plugin({
          id: 'motrix.a-resolver',
          hostPermissions: ['*://*.site.com/*'],
          origin: 'builtin',
        })
      ),
      pluginHost
    )
    expect(await resolve('https://www.site.com/x')).toEqual({
      videoUrl: 'https://c/v',
      audioUrl: 'https://c/a',
      container: 'mkv',
    })
  })

  it('passes cookies to the resolve command when a cookie header is provided', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({
      kind: 'mux',
      video: { url: 'https://c/v' },
      audio: { url: 'https://c/a' },
      container: 'mp4',
    })
    const pluginHost = {
      activate: vi.fn().mockResolvedValue(undefined),
      invokeCommand,
    } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'community.bilibili-resolver',
          hostPermissions: ['*://*.bilibili.com/*'],
        })
      ),
      pluginHost
    )
    await resolve(BILI, 'SESSDATA=x')
    expect(invokeCommand).toHaveBeenCalledWith(
      'community.bilibili-resolver',
      'community.bilibili-resolver.resolve',
      { url: BILI, cookies: 'SESSDATA=x' }
    )
  })
})
