import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — .mjs without types
import {
  isBuildOnlyEntry,
  mdxpRuntimeFilter,
  pruneBuildOnly,
} from '../../scripts/staged-package-pruning.mjs'

describe('MDXP runtime package', () => {
  const keep = mdxpRuntimeFilter()
  it.each([
    '',
    'package.json',
    'LICENSE',
    'NOTICE.md',
    'dist',
    'dist/index.js',
    'dist/browser.js',
    'dist/schemas/media-formats.js',
    'dist/transports/ws.js',
  ])('retains runtime/attribution %s', (entry) =>
    expect(keep(entry)).toBe(true)
  )
  it.each([
    'docs',
    'docs/media-formats.md',
    'docs/media-formats.zh-CN.md',
    'src',
    'src/index.ts',
    'dist/index.d.ts',
    'dist/index.js.map',
  ])('omits build/documentation %s', (entry) => expect(keep(entry)).toBe(false))
})

describe('isBuildOnlyEntry', () => {
  it.each([
    'index.js.map',
    'dist/bundle.mjs.map',
    'index.d.ts',
    'index.d.mts',
    'index.d.cts',
    'src/impl.ts',
    'src/component.tsx',
    'lib/loader.mts',
    'types.flow',
    'README.md',
    'readme.markdown',
    'CHANGELOG.md',
    'HISTORY.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
  ])('prunes %s', (entry) => {
    expect(isBuildOnlyEntry(entry)).toBe(true)
  })

  it.each([
    // Attribution must ship: the notice requirement covers what is
    // distributed, and these files still are.
    'LICENSE',
    'LICENSE.md',
    'LICENCE',
    'license.txt',
    'NOTICE',
    'NOTICE.md',
    // Payloads a running package genuinely reads.
    'index.js',
    'package.json',
    'data/table.json',
    'vendor/engine.wasm',
    'prebuilds/linux-x64.node',
    'lib/worker.cjs',
    'assets/icon.svg',
    // Not documentation: the stem only has to start with the same letters.
    'readme-parser.js',
    'history-store.js',
    'security-policy.json',
  ])('keeps %s', (entry) => {
    expect(isBuildOnlyEntry(entry)).toBe(false)
  })
})

describe('pruneBuildOnly', () => {
  it('prunes build-time files when no allowlist is supplied', () => {
    const filter = pruneBuildOnly()
    expect(filter('')).toBe(true) // the package root itself
    expect(filter('index.js')).toBe(true)
    expect(filter('LICENSE')).toBe(true)
    expect(filter('index.d.ts')).toBe(false)
    expect(filter('index.js.map')).toBe(false)
  })

  it('intersects an allowlist with the build-time rule', () => {
    const allowlist = (relative: string) =>
      relative === 'package.json' ||
      relative === 'LICENSE' ||
      relative.startsWith('lib/')
    const filter = pruneBuildOnly(allowlist)

    expect(filter('')).toBe(true)
    expect(filter('package.json')).toBe(true)
    expect(filter('LICENSE')).toBe(true)
    expect(filter('lib/index.js')).toBe(true)
    // Allowed by the package rule, still build-time-only.
    expect(filter('lib/index.d.ts')).toBe(false)
    expect(filter('lib/index.js.map')).toBe(false)
    // Rejected by the package rule regardless.
    expect(filter('src/native.cpp')).toBe(false)
  })

  it('normalises platform separators before matching', () => {
    const filter = pruneBuildOnly()
    expect(filter(path.join('dist', 'index.d.ts'))).toBe(false)
    expect(filter(path.join('dist', 'index.js'))).toBe(true)
  })
})
