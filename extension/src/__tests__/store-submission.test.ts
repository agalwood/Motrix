// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { strToU8, zipSync } from 'fflate'
import { validateConfig } from 'publish-browser-extension'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyStoreProvenance } from '#store-provenance'
import {
  FIREFOX_EXTENSION_ID,
  parseDryRun,
  releaseFiles,
  selectStores,
  verifyRelease,
} from '#store-release'
import { submissionConfig, submitStore } from '#store-submitter'

const tag = 'v0.1.11'
const files = releaseFiles(tag)
const directories: string[] = []
const settings = {
  CHROME_PUBLISHER_ID: 'publisher-id',
  CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL:
    'publisher@example.iam.gserviceaccount.com',
  CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: 'test-private-key',
  EDGE_PRODUCT_ID: '12345678-1234-1234-1234-123456789abc',
  EDGE_CLIENT_ID: 'client-id',
  EDGE_API_KEY: 'test-edge-key',
  FIREFOX_JWT_ISSUER: 'user:123:456',
  FIREFOX_JWT_SECRET: 'test-firefox-secret',
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'motrix-store-test-'))
  directories.push(directory)
  const archives: Record<string, Record<string, Uint8Array>> = {
    [files.chromium]: {
      'manifest.json': strToU8(
        JSON.stringify({
          manifest_version: 3,
          version: files.version,
          background: { service_worker: 'background.js' },
        })
      ),
    },
    [files.firefox]: {
      'manifest.json': strToU8(
        JSON.stringify({
          manifest_version: 3,
          version: files.version,
          background: { scripts: ['background.js'] },
          browser_specific_settings: { gecko: { id: FIREFOX_EXTENSION_ID } },
        })
      ),
    },
    [files.source]: {
      'package.json': strToU8(JSON.stringify({ version: files.version })),
      'pnpm-lock.yaml': strToU8('lockfileVersion: 9.0'),
      'pnpm-workspace.yaml': strToU8(
        'patchedDependencies:\n  dependency: patches/dependency.patch\n'
      ),
      'patches/dependency.patch': strToU8('test patch'),
      'README.md': strToU8('Build instructions'),
    },
  }
  writeFileSync(
    join(directory, 'release.json'),
    JSON.stringify({
      tagName: tag,
      isDraft: false,
      isPrerelease: false,
    })
  )
  const save = () => {
    const checksums = Object.entries(archives).map(([name, entries]) => {
      const archive = zipSync(entries)
      writeFileSync(join(directory, name), archive)
      return `${createHash('sha256').update(archive).digest('hex')}  ${name}`
    })
    writeFileSync(
      join(directory, 'SHA256SUMS.txt'),
      `${checksums.join('\n')}\n`
    )
  }
  save()
  return { directory, archives, save }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('store release verification', () => {
  it.each([
    '',
    'main',
    '../v1.2.3',
    'v1.2.3-beta.1',
    'v1.2.3\n',
    'v1.2.3;exit',
  ])('rejects invalid release tag %j', (value) => {
    expect(() => releaseFiles(value)).toThrow()
  })

  it('selects all stores or exactly one store', () => {
    expect(selectStores('all')).toEqual(['chrome', 'edge', 'firefox'])
    expect(selectStores('edge')).toEqual(['edge'])
    expect(() => selectStores('unknown')).toThrow()
  })

  it('requires an explicit dry-run choice', () => {
    expect(parseDryRun('true')).toBe(true)
    expect(parseDryRun('false')).toBe(false)
    expect(() => parseDryRun(undefined)).toThrow()
    expect(() => parseDryRun('0')).toThrow()
  })

  it('accepts matching published release archives', () => {
    expect(verifyRelease(fixture().directory, tag)).toEqual(files)
  })

  it('accepts the ./ paths emitted by the existing release workflow', () => {
    const { directory } = fixture()
    const path = join(directory, 'SHA256SUMS.txt')
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replaceAll('  motrix-', '  ./motrix-')
    )
    expect(verifyRelease(directory, tag)).toEqual(files)
  })

  it.each([
    { tagName: 'v0.1.10', isDraft: false, isPrerelease: false },
    { tagName: tag, isDraft: true, isPrerelease: false },
    { tagName: tag, isDraft: false, isPrerelease: true },
  ])('rejects an ineligible release before upload: %j', (metadata) => {
    const { directory } = fixture()
    writeFileSync(join(directory, 'release.json'), JSON.stringify(metadata))
    expect(() => verifyRelease(directory, tag)).toThrow('published')
  })

  it('rejects an altered archive', () => {
    const { directory } = fixture()
    writeFileSync(join(directory, files.chromium), 'corrupted')
    expect(() => verifyRelease(directory, tag)).toThrow('SHA256')
  })

  it.each(['duplicate', 'missing', 'unsafe'])(
    'rejects %s checksum entries',
    (kind) => {
      const { directory } = fixture()
      const path = join(directory, 'SHA256SUMS.txt')
      const lines = readFileSync(path, 'utf8').trim().split('\n')
      if (kind === 'duplicate') lines.push(lines[0])
      if (kind === 'missing') lines.pop()
      if (kind === 'unsafe')
        lines[0] = lines[0].replace(files.chromium, '../outside.zip')
      writeFileSync(path, lines.join('\n'))
      expect(() => verifyRelease(directory, tag)).toThrow()
    }
  )

  it('rejects the wrong version even when its checksum is valid', () => {
    const { directory, archives, save } = fixture()
    archives[files.chromium]['manifest.json'] = strToU8(
      JSON.stringify({ manifest_version: 3, version: '0.1.10' })
    )
    save()
    expect(() => verifyRelease(directory, tag)).toThrow('manifest version')
  })

  it('rejects a different Firefox extension', () => {
    const { directory, archives, save } = fixture()
    archives[files.firefox]['manifest.json'] = strToU8(
      JSON.stringify({ manifest_version: 3, version: files.version })
    )
    save()
    expect(() => verifyRelease(directory, tag)).toThrow('identity')
  })

  it('rejects sources with a missing pnpm patch', () => {
    const { directory, archives, save } = fixture()
    delete archives[files.source]['patches/dependency.patch']
    save()
    expect(() => verifyRelease(directory, tag)).toThrow(
      'missing patches/dependency.patch'
    )
  })

  it('rejects source archives from another version', () => {
    const { directory, archives, save } = fixture()
    archives[files.source]['package.json'] = strToU8('{"version":"0.1.10"}')
    save()
    expect(() => verifyRelease(directory, tag)).toThrow(
      'Source package version'
    )
  })
})

describe('store release provenance', () => {
  const sha = 'a'.repeat(40)
  const runner = () =>
    vi.fn((command: string, args: string[]) =>
      command === 'git' && args[0] === 'rev-parse' ? sha : ''
    )

  it('requires signed provenance for every archive and the checksum manifest', () => {
    const { directory } = fixture()
    const run = runner()
    expect(verifyStoreProvenance({ directory, tag }, run)).toBe(sha)
    const checks = run.mock.calls.filter(([command]) => command === 'gh')
    expect(checks.map(([, args]) => args[2])).toEqual(
      [files.chromium, files.firefox, files.source, 'SHA256SUMS.txt'].map(
        (name) => resolve(directory, name)
      )
    )
    for (const [, args] of checks) {
      expect(args.slice(3)).toEqual([
        '--repo',
        'motrixapp/motrix-extension',
        '--signer-workflow',
        'motrixapp/motrix-extension/.github/workflows/release.yml',
        '--source-ref',
        `refs/tags/${tag}`,
        '--source-digest',
        sha,
        '--signer-digest',
        sha,
        '--deny-self-hosted-runners',
      ])
    }
  })

  it('rejects a corrupted archive before invoking git or gh', () => {
    const { directory } = fixture()
    writeFileSync(join(directory, files.chromium), 'altered')
    const run = runner()
    expect(() => verifyStoreProvenance({ directory, tag }, run)).toThrow(
      'SHA256'
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a tag changed while waiting for approval', () => {
    const run = runner()
    expect(() =>
      verifyStoreProvenance(
        {
          directory: fixture().directory,
          tag,
          expectedSha: 'b'.repeat(40),
        },
        run
      )
    ).toThrow('no longer matches')
    expect(run.mock.calls.some(([command]) => command === 'gh')).toBe(false)
  })

  it.each(['', 'main', 'abc', `${sha};echo injected`])(
    'rejects malformed expected SHA %j',
    (expectedSha) => {
      const run = runner()
      expect(() =>
        verifyStoreProvenance(
          {
            directory: fixture().directory,
            tag,
            expectedSha,
          },
          run
        )
      ).toThrow('complete release commit SHA')
      expect(run).not.toHaveBeenCalled()
    }
  )

  it('rejects commits outside main before checking attestations', () => {
    const run = runner().mockImplementation((command, args) => {
      if (command === 'git' && args[0] === 'merge-base')
        throw new Error('not an ancestor')
      return args[0] === 'rev-parse' ? sha : ''
    })
    expect(() =>
      verifyStoreProvenance({ directory: fixture().directory, tag }, run)
    ).toThrow('not an ancestor')
    expect(run.mock.calls.some(([command]) => command === 'gh')).toBe(false)
  })

  it('fails closed if provenance is missing or has the wrong signer, ref, or digest', () => {
    const run = runner().mockImplementation((command, args) => {
      if (command === 'gh') throw new Error('attestation verification failed')
      return args[0] === 'rev-parse' ? sha : ''
    })
    expect(() =>
      verifyStoreProvenance({ directory: fixture().directory, tag }, run)
    ).toThrow('attestation verification failed')
    expect(run.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(
      1
    )
  })
})

describe('single-store submission', () => {
  it('runs the installed Edge adapter in dry-run mode without contacting stores or reading unrelated ZIP variables', async () => {
    const { directory } = fixture()
    const fetch = vi
      .fn()
      .mockRejectedValue(new Error('Unexpected network call'))
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('CHROME_ZIP', '/unrelated-chrome.zip')
    await submitStore(
      { store: 'edge', tag, directory, dryRun: true },
      { env: settings }
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('propagates a real adapter HTTP failure without letting the publisher exit the process', async () => {
    const { directory } = fixture()
    const fetch = vi.fn().mockImplementation(async (_url, init) => {
      // Fetch consumes the upload stream before fixture cleanup can remove it.
      await buffer(init.body)
      return new Response('{"error":"unauthorized"}', {
        status: 401,
        statusText: 'Unauthorized',
      })
    })
    vi.stubGlobal('fetch', fetch)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Unexpected process exit')
    })
    await expect(
      submitStore(
        { store: 'edge', tag, directory, dryRun: false },
        { env: settings }
      )
    ).rejects.toThrow('401')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
  })

  it.each(['chrome', 'edge', 'firefox'])(
    'uses supported publisher options for %s only',
    (store) => {
      const config = submissionConfig(
        { store, tag, directory: 'artifacts', dryRun: true },
        settings
      )
      expect(Object.keys(config).sort()).toEqual(['dryRun', store].sort())
      expect(() => validateConfig(config)).not.toThrow()
    }
  )

  it('uses Chrome API v2 without cancelling review or bypassing review', () => {
    const { chrome } = submissionConfig(
      { store: 'chrome', tag, directory: 'artifacts', dryRun: false },
      settings
    )
    expect(chrome).toMatchObject({
      apiVersion: 'v2',
      cancelPending: false,
      skipReview: false,
      skipSubmitReview: false,
    })
  })

  it('requires the Edge Partner Center product GUID', () => {
    expect(() =>
      submissionConfig(
        { store: 'edge', tag, directory: '.', dryRun: false },
        {
          ...settings,
          EDGE_PRODUCT_ID: 'efcflljngohddnmfmebiamigoikmdfbf',
        }
      )
    ).toThrow('GUID')
  })

  it('names missing settings without including other credentials', () => {
    expect(() =>
      submissionConfig(
        { store: 'edge', tag, directory: '.', dryRun: false },
        {
          EDGE_PRODUCT_ID: settings.EDGE_PRODUCT_ID,
        }
      )
    ).toThrow('Missing required setting: EDGE_CLIENT_ID')
  })

  it('submits the verified Firefox package and matching sources', async () => {
    const { directory } = fixture()
    const publish = vi.fn().mockResolvedValue({ firefox: { success: true } })
    await submitStore(
      { store: 'firefox', tag, directory, dryRun: false },
      { env: settings, publish }
    )
    expect(publish).toHaveBeenCalledWith({
      dryRun: false,
      firefox: expect.objectContaining({
        channel: 'listed',
        zip: resolve(directory, files.firefox),
        sourcesZip: resolve(directory, files.source),
      }),
    })
  })

  it('does not override manifest compatibility after Firefox creates a version', async () => {
    const { directory } = fixture()
    const calls: { url: string; method: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const method = init?.method ?? 'GET'
        calls.push({ url: String(url), method })
        if (init?.body) await new Response(init.body).arrayBuffer()
        if (method === 'PATCH')
          throw new Error('Unexpected compatibility override')
        const body = String(url).includes('/versions/')
          ? { id: 12, file: { id: 34 } }
          : String(url).includes('/upload/')
            ? {
                uuid: 'upload-id',
                processed: true,
                valid: true,
                validation: { errors: 0, warnings: 0, notices: 0 },
              }
            : { id: 56 }
        return new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
        })
      })
    )
    await submitStore(
      { store: 'firefox', tag, directory, dryRun: false },
      { env: settings }
    )
    expect(calls.filter(({ method }) => method === 'POST')).toHaveLength(2)
    expect(calls.some(({ method }) => method === 'PATCH')).toBe(false)
  }, 10000)

  it('does not contact a store when artifact validation fails', async () => {
    const { directory } = fixture()
    writeFileSync(join(directory, files.source), 'invalid')
    const publish = vi.fn()
    await expect(
      submitStore(
        { store: 'chrome', tag, directory, dryRun: false },
        { env: settings, publish }
      )
    ).rejects.toThrow('SHA256')
    expect(publish).not.toHaveBeenCalled()
  })

  it('reports a partial or missing publisher result as a failure', async () => {
    const { directory } = fixture()
    const publish = vi.fn().mockResolvedValue({ chrome: { success: false } })
    await expect(
      submitStore(
        { store: 'chrome', tag, directory, dryRun: false },
        { env: settings, publish }
      )
    ).rejects.toThrow('submission failed')
  })
})
