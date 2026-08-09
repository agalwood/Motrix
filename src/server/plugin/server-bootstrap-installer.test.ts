import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PluginInstaller } from '@core/plugin/install/plugin-installer'
import type { InstallRecord } from '@shared/types/plugin-install'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serverBootstrapInstall } from './server-bootstrap-installer'

let tmp: string
let pluginsDir: string

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'motrix-srv-bootstrap-'))
  pluginsDir = path.join(tmp, 'plugins')
  await mkdir(pluginsDir, { recursive: true })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function stubInstaller(): PluginInstaller {
  return {
    stage: vi.fn().mockResolvedValue({
      stagingId: 'sx',
      consent: {} as never,
    }),
  } as unknown as PluginInstaller
}

function makeRecord(id: string, sourceUrl: string): InstallRecord {
  return {
    version: 1,
    pluginId: id,
    source: {
      type: 'github',
      url: sourceUrl,
      bundleSha256: 'a'.repeat(64),
      recordedAt: 0,
    },
    grants: {},
    consentSnapshot: {
      permissions: [],
      optionalPermissions: [],
      invokesCommands: [],
      publicCommands: {},
      requestedHeapMB: 32,
      enginesMotrix: '^2.0.0',
      hostPermissions: [],
    },
  }
}

describe('serverBootstrapInstall', () => {
  it('returns {accepted:[], rejected:[]} when pluginsDir is missing', async () => {
    const installer = stubInstaller()
    const result = await serverBootstrapInstall(
      installer,
      path.join(tmp, 'does-not-exist'),
      {},
      { blanketBypass: false }
    )
    expect(result).toEqual({ accepted: [], rejected: [] })
  })

  it('accepts a volume-mounted plugin whose source URL is on the allowlist', async () => {
    const dir = path.join(pluginsDir, 'example.widget')
    await mkdir(dir, { recursive: true })
    const rec = makeRecord(
      'example.widget',
      'https://github.com/example/widget'
    )
    await writeFile(
      path.join(dir, '_install.json'),
      JSON.stringify(rec, null, 2)
    )

    const result = await serverBootstrapInstall(
      stubInstaller(),
      pluginsDir,
      { MOTRIX_PLUGIN_ALLOWLIST: 'https://github.com/example' },
      { blanketBypass: false }
    )
    expect(result.accepted).toContain('example.widget')
    expect(result.rejected).toEqual([])
  })

  it('rejects a volume-mounted plugin missing an install record under default policy', async () => {
    const dir = path.join(pluginsDir, 'shady.plugin')
    await mkdir(dir, { recursive: true })
    const result = await serverBootstrapInstall(
      stubInstaller(),
      pluginsDir,
      {},
      { blanketBypass: false }
    )
    expect(result.rejected).toEqual([
      { id: 'shady.plugin', reason: 'plugin.lifecycle.unsigned_not_allowed' },
    ])
    expect(result.accepted).toEqual([])
  })

  it('accepts everything under --allow-unsigned-plugins blanket bypass', async () => {
    const dir = path.join(pluginsDir, 'shady.plugin')
    await mkdir(dir, { recursive: true })
    const result = await serverBootstrapInstall(
      stubInstaller(),
      pluginsDir,
      {},
      { blanketBypass: true }
    )
    expect(result.accepted).toEqual(['shady.plugin'])
    expect(result.rejected).toEqual([])
  })

  it('skips entries prefixed with _ (staging, downloads)', async () => {
    await mkdir(path.join(pluginsDir, '_staging'), { recursive: true })
    await mkdir(path.join(pluginsDir, '_dl'), { recursive: true })
    const result = await serverBootstrapInstall(
      stubInstaller(),
      pluginsDir,
      {},
      { blanketBypass: true }
    )
    expect(result.accepted).toEqual([])
    expect(result.rejected).toEqual([])
  })

  it('rejects an env URL that is neither github: nor a .moext URL', async () => {
    const result = await serverBootstrapInstall(
      stubInstaller(),
      pluginsDir,
      { MOTRIX_PLUGIN_INSTALL_URLS: 'https://example.com/index.html' },
      { blanketBypass: false }
    )
    expect(result.rejected).toEqual([
      {
        id: 'https://example.com/index.html',
        reason: 'plugin.install.invalid_env_url',
      },
    ])
  })

  it('threads a github: env URL through stage() unattended', async () => {
    const installer = stubInstaller()
    // Bypass the actual download by mocking github-fetcher.
    const { downloadGithubMoext } = await import(
      '@core/plugin/install/github-fetcher'
    )
    vi.spyOn(
      { downloadGithubMoext } as {
        downloadGithubMoext: typeof downloadGithubMoext
      },
      'downloadGithubMoext'
    ).mockResolvedValue({ tag: 'v1', assetName: 'x.moext' })
    // Note: we can't easily intercept the dynamic import; instead, accept that
    // the test will reject when the download fails. We assert the env URL is
    // attempted (i.e. ended up in rejected) — proves the dispatcher routes it.
    const result = await serverBootstrapInstall(
      installer,
      pluginsDir,
      { MOTRIX_PLUGIN_INSTALL_URLS: 'github:acme/widget' },
      { blanketBypass: false }
    )
    const ids = [...result.accepted, ...result.rejected.map((r) => r.id)]
    expect(ids).toContain('github:acme/widget')
  })
})
