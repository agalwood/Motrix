import type { PluginManifest } from '@shared/types/plugin'
import { describe, expect, it } from 'vitest'
import {
  isEligible,
  matchPattern,
  urlMatchesHostPermissions,
} from './eligibility'

function makeManifest(opts: {
  hooks?: Record<string, { role?: string }>
  hostPermissions?: string[]
}): PluginManifest {
  return {
    manifestVersion: 1,
    id: 'test.plugin',
    name: 'Test',
    version: '1.0.0',
    description: '',
    main: 'dist/plugin.js',
    permissions: [],
    hostPermissions: opts.hostPermissions,
    activationEvents: [],
    engines: { motrix: '>=2.0.0 <3.0.0' },
    categories: [],
    contributes: { hooks: opts.hooks },
  } as PluginManifest
}

describe('matchPattern', () => {
  it('<all_urls> matches http:// URLs', () => {
    expect(matchPattern('<all_urls>', 'http://example.com/path')).toBe(true)
  })

  it('<all_urls> matches https:// URLs', () => {
    expect(matchPattern('<all_urls>', 'https://example.com')).toBe(true)
  })

  it('<all_urls> does NOT match file:// URLs', () => {
    expect(matchPattern('<all_urls>', 'file:///usr/local/file.txt')).toBe(false)
  })

  it('<all_urls> does NOT match ftp:// URLs', () => {
    expect(matchPattern('<all_urls>', 'ftp://example.com/file')).toBe(false)
  })

  it('wildcard subdomain pattern matches https URL', () => {
    expect(
      matchPattern('*://*.example.com/*', 'https://www.example.com/x')
    ).toBe(true)
  })

  it('wildcard subdomain pattern matches http URL', () => {
    expect(
      matchPattern('*://*.example.com/*', 'http://sub.example.com/path')
    ).toBe(true)
  })

  it('specific scheme pattern does NOT match different scheme', () => {
    // http:// pattern must not match https://
    expect(
      matchPattern('http://*.example.com/*', 'https://www.example.com/x')
    ).toBe(false)
  })

  it('*://api.example.com/* matches https://api.example.com/v1/list', () => {
    expect(
      matchPattern('*://api.example.com/*', 'https://api.example.com/v1/list')
    ).toBe(true)
  })

  it('*://api.example.com/* matches http://api.example.com/v1/list', () => {
    expect(
      matchPattern('*://api.example.com/*', 'http://api.example.com/v1/list')
    ).toBe(true)
  })

  it('http://*.example.com/* does NOT match https://www.example.com/x', () => {
    expect(
      matchPattern('http://*.example.com/*', 'https://www.example.com/x')
    ).toBe(false)
  })
})

describe('isEligible', () => {
  // Case 1: plugin declares beforeCreate + hostPermissions matching task URL
  it('beforeCreate with matching hostPermissions is eligible', () => {
    const manifest = makeManifest({
      hooks: { beforeCreate: {} },
      hostPermissions: ['*://*.example.com/*'],
    })
    expect(
      isEligible({
        manifest,
        hook: 'beforeCreate',
        taskUrl: 'https://www.example.com/x',
      })
    ).toBe(true)
  })

  // Case 2: I29 — beforeCreate with no hostPermissions + taskUrl → not eligible
  it('beforeCreate without hostPermissions and with taskUrl is not eligible (I29)', () => {
    const manifest = makeManifest({
      hooks: { beforeCreate: {} },
      hostPermissions: [],
    })
    expect(
      isEligible({
        manifest,
        hook: 'beforeCreate',
        taskUrl: 'https://example.com/file',
      })
    ).toBe(false)
  })

  it('beforeCreate with undefined hostPermissions and taskUrl is not eligible (I29)', () => {
    const manifest = makeManifest({
      hooks: { beforeCreate: {} },
      // hostPermissions not set → undefined → []
    })
    expect(
      isEligible({
        manifest,
        hook: 'beforeCreate',
        taskUrl: 'https://example.com/file',
      })
    ).toBe(false)
  })

  // Case 3: <all_urls> matches any http/https URL
  it('<all_urls> hostPermission matches any https URL', () => {
    const manifest = makeManifest({
      hooks: { beforeCreate: {} },
      hostPermissions: ['<all_urls>'],
    })
    expect(
      isEligible({
        manifest,
        hook: 'beforeCreate',
        taskUrl: 'https://anything.xyz/path',
      })
    ).toBe(true)
  })

  it('<all_urls> hostPermission matches any http URL', () => {
    const manifest = makeManifest({
      hooks: { beforeCreate: {} },
      hostPermissions: ['<all_urls>'],
    })
    expect(
      isEligible({
        manifest,
        hook: 'beforeCreate',
        taskUrl: 'http://other.example.com/',
      })
    ).toBe(true)
  })

  // Case 4: <all_urls> does NOT match file:// or ftp://
  it('<all_urls> does NOT make beforeCreate eligible for file:// taskUrl', () => {
    const manifest = makeManifest({
      hooks: { beforeCreate: {} },
      hostPermissions: ['<all_urls>'],
    })
    expect(
      isEligible({
        manifest,
        hook: 'beforeCreate',
        taskUrl: 'file:///local/file.zip',
      })
    ).toBe(false)
  })

  it('<all_urls> does NOT make beforeCreate eligible for ftp:// taskUrl', () => {
    const manifest = makeManifest({
      hooks: { beforeCreate: {} },
      hostPermissions: ['<all_urls>'],
    })
    expect(
      isEligible({
        manifest,
        hook: 'beforeCreate',
        taskUrl: 'ftp://ftp.example.com/file',
      })
    ).toBe(false)
  })

  // Case 5: afterComplete hook never URL-filtered
  it('afterComplete is eligible regardless of hostPermissions', () => {
    const manifest = makeManifest({
      hooks: { afterComplete: {} },
      // no hostPermissions
    })
    expect(
      isEligible({
        manifest,
        hook: 'afterComplete',
        taskUrl: 'https://example.com/file',
      })
    ).toBe(true)
  })

  it('afterComplete is eligible even with empty hostPermissions', () => {
    const manifest = makeManifest({
      hooks: { afterComplete: {} },
      hostPermissions: [],
    })
    expect(
      isEligible({
        manifest,
        hook: 'afterComplete',
        taskUrl: 'https://example.com/file',
      })
    ).toBe(true)
  })

  // Case 6: onError hook never URL-filtered
  it('onError is eligible regardless of hostPermissions', () => {
    const manifest = makeManifest({
      hooks: { onError: {} },
      // no hostPermissions
    })
    expect(
      isEligible({
        manifest,
        hook: 'onError',
        taskUrl: 'https://example.com/file',
      })
    ).toBe(true)
  })

  it('onError is eligible with empty hostPermissions', () => {
    const manifest = makeManifest({
      hooks: { onError: {} },
      hostPermissions: [],
    })
    expect(
      isEligible({
        manifest,
        hook: 'onError',
        taskUrl: 'https://example.com/file',
      })
    ).toBe(true)
  })

  // Case 7: hook not declared in contributes.hooks → not eligible
  it('undeclared hook is not eligible regardless of taskUrl', () => {
    const manifest = makeManifest({
      hooks: { afterComplete: {} },
      hostPermissions: ['<all_urls>'],
    })
    expect(
      isEligible({
        manifest,
        hook: 'beforeCreate',
        taskUrl: 'https://example.com/file',
      })
    ).toBe(false)
  })

  it('undeclared hook is not eligible without taskUrl', () => {
    const manifest = makeManifest({
      hooks: {},
      hostPermissions: ['<all_urls>'],
    })
    expect(isEligible({ manifest, hook: 'onError' })).toBe(false)
  })

  // Case 8: beforeCreate without taskUrl → eligible (BT/magnet — no HTTP URL)
  it('beforeCreate without taskUrl is eligible (BT/magnet tasks)', () => {
    const manifest = makeManifest({
      hooks: { beforeCreate: {} },
      // no hostPermissions
    })
    expect(isEligible({ manifest, hook: 'beforeCreate' })).toBe(true)
  })

  it('beforeCreate without taskUrl is eligible even with empty hostPermissions', () => {
    const manifest = makeManifest({
      hooks: { beforeCreate: {} },
      hostPermissions: [],
    })
    expect(isEligible({ manifest, hook: 'beforeCreate' })).toBe(true)
  })

  // I42: eligibility is per (plugin, task, hook) — activation source irrelevant
  it('multiple patterns — only second matches — eligible', () => {
    const manifest = makeManifest({
      hooks: { beforeCreate: {} },
      hostPermissions: ['*://other.com/*', '*://*.example.com/*'],
    })
    expect(
      isEligible({
        manifest,
        hook: 'beforeCreate',
        taskUrl: 'https://www.example.com/resource',
      })
    ).toBe(true)
  })

  it('no pattern matches taskUrl — not eligible', () => {
    const manifest = makeManifest({
      hooks: { beforeCreate: {} },
      hostPermissions: ['*://api.example.com/*'],
    })
    expect(
      isEligible({
        manifest,
        hook: 'beforeCreate',
        taskUrl: 'https://www.other.com/file',
      })
    ).toBe(false)
  })

  // beforeFinalize also URL-filtered
  it('beforeFinalize with matching hostPermissions is eligible', () => {
    const manifest = makeManifest({
      hooks: { beforeFinalize: {} },
      hostPermissions: ['*://api.example.com/*'],
    })
    expect(
      isEligible({
        manifest,
        hook: 'beforeFinalize',
        taskUrl: 'https://api.example.com/v1/list',
      })
    ).toBe(true)
  })

  it('beforeFinalize without hostPermissions and taskUrl is not eligible (I29)', () => {
    const manifest = makeManifest({
      hooks: { beforeFinalize: {} },
      hostPermissions: [],
    })
    expect(
      isEligible({
        manifest,
        hook: 'beforeFinalize',
        taskUrl: 'https://api.example.com/v1/list',
      })
    ).toBe(false)
  })

  it('beforeFinalize without taskUrl is eligible (no URL filtering needed)', () => {
    const manifest = makeManifest({
      hooks: { beforeFinalize: {} },
      hostPermissions: [],
    })
    expect(isEligible({ manifest, hook: 'beforeFinalize' })).toBe(true)
  })
})

describe('urlMatchesHostPermissions', () => {
  const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

  it('matches when a pattern matches the url', () => {
    expect(urlMatchesHostPermissions(['*://*.youtube.com/*'], YT)).toBe(true)
  })

  it('returns false when no pattern matches', () => {
    expect(urlMatchesHostPermissions(['*://*.bilibili.com/*'], YT)).toBe(false)
  })

  it('empty array matches nothing (rule I29)', () => {
    expect(urlMatchesHostPermissions([], YT)).toBe(false)
  })

  it('undefined matches nothing (rule I29)', () => {
    expect(urlMatchesHostPermissions(undefined, YT)).toBe(false)
  })

  it('matches any one of several patterns', () => {
    expect(
      urlMatchesHostPermissions(
        ['*://*.youtube.com/*', '*://youtu.be/*'],
        'https://youtu.be/dQw4w9WgXcQ'
      )
    ).toBe(true)
  })

  it('returns false for a non-http/garbage url', () => {
    expect(
      urlMatchesHostPermissions(['*://*.youtube.com/*'], 'not a url')
    ).toBe(false)
  })

  it('glob edge: *://*.youtube.com/* does NOT match bare youtube.com (no subdomain)', () => {
    // Documents the source-of-truth behavior: the glob requires a subdomain.
    // If bare-domain matching is wanted, fix the manifest, not this helper.
    expect(
      urlMatchesHostPermissions(
        ['*://*.youtube.com/*'],
        'https://youtube.com/watch?v=x'
      )
    ).toBe(false)
  })

  it('*://*/* matches an arbitrary url — the helper itself is broad', () => {
    // Proves this helper is plugin-agnostic and does no scoping on its own:
    // scoping to a SPECIFIC resolver plugin's manifest is the caller's job
    // (the mux pre-resolve seam in src/main/bridge/index.ts), verified in
    // make-resolve-to-mux.test.ts's gate-1 regression-lock case.
    expect(
      urlMatchesHostPermissions(['*://*/*'], 'https://example.com/file.zip')
    ).toBe(true)
  })
})
