import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import {
  parseArgs,
  replaceApplicationSource,
} from '../../scripts/prepare-flatpak-project.mjs'

const require = createRequire(import.meta.url)
const parseYaml = require('js-yaml').load as (source: string) => unknown
const manifest = parseYaml(
  readFileSync(
    path.join(process.cwd(), 'flatpak/app.motrix.native.yml'),
    'utf8'
  )
) as {
  modules: Array<{
    name: string
    sources: unknown[]
    'build-options'?: { env?: Record<string, string> }
  }>
}

describe('prepare-flatpak-project', () => {
  it('replaces only the application git source with the CI archive', () => {
    const prepared = replaceApplicationSource(
      manifest,
      'motrix-source.tar.gz'
    ) as typeof manifest
    const originalMotrix = manifest.modules.find(
      (candidate) => candidate.name === 'motrix'
    )
    const preparedMotrix = prepared.modules.find(
      (candidate) => candidate.name === 'motrix'
    )

    expect(preparedMotrix?.sources[0]).toEqual({
      type: 'archive',
      path: 'motrix-source.tar.gz',
      'strip-components': 0,
    })
    expect(preparedMotrix?.sources.slice(1)).toEqual(
      originalMotrix?.sources.slice(1)
    )
    expect(
      prepared.modules.find((candidate) => candidate.name === 'aria2')
    ).toEqual(manifest.modules.find((candidate) => candidate.name === 'aria2'))
  })

  it('rejects an ambiguous application source', () => {
    expect(() =>
      replaceApplicationSource(
        {
          modules: [
            {
              name: 'motrix',
              sources: [
                { type: 'git', url: 'https://example.test/a.git' },
                { type: 'git', url: 'https://example.test/b.git' },
              ],
            },
          ],
        },
        'source.tar.gz'
      )
    ).toThrow('exactly one git source')
  })

  it('pins the sandbox node-gyp headers to the packaged electron version', () => {
    // generated-sources unpacks the electron release headers under
    // flatpak-node/cache/node-gyp/<electron version>; a stale nodedir makes
    // electron-rebuild's gyp fail on a dangling include path (run
    // 31363983647 shipped 43.3.0 sources against a 43.2.0 nodedir).
    const electronVersion = (
      JSON.parse(
        readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
      ) as { devDependencies: Record<string, string> }
    ).devDependencies.electron.replace(/^[~^]/, '')
    const motrix = manifest.modules.find(
      (candidate) => candidate.name === 'motrix'
    )
    expect(motrix?.['build-options']?.env?.npm_config_nodedir).toBe(
      `/run/build/motrix/flatpak-node/cache/node-gyp/${electronVersion}`
    )
  })

  it('parses explicit workflow paths and rejects unknown flags', () => {
    expect(
      parseArgs([
        '--manifest',
        'flatpak/release.yml',
        '--output',
        'flatpak/ci.yml',
        '--archive',
        'flatpak/source.tar.gz',
        '--ref',
        'abc123',
      ])
    ).toEqual({
      manifest: 'flatpak/release.yml',
      output: 'flatpak/ci.yml',
      archive: 'flatpak/source.tar.gz',
      ref: 'abc123',
    })
    expect(() => parseArgs(['--surprise', 'value'])).toThrow('unknown flag')
  })
})
