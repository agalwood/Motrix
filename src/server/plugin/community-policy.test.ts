import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createServerCommunityPluginPolicy,
  parseAllowUnmanagedPlugins,
} from './community-policy'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe('Server community plugin policy', () => {
  it('parses the explicit unmanaged-plugin override strictly', () => {
    expect(parseAllowUnmanagedPlugins(undefined)).toBe(false)
    expect(parseAllowUnmanagedPlugins('true')).toBe(true)
    expect(parseAllowUnmanagedPlugins('0')).toBe(false)
    expect(() => parseAllowUnmanagedPlugins('yes')).toThrow(
      'MOTRIX_ALLOW_UNMANAGED_PLUGINS'
    )
  })

  it('requires a valid installer record by default', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'motrix-plugin-policy-'))
    cleanup.push(dir)
    const policy = createServerCommunityPluginPolicy({
      allowUnmanagedPlugins: false,
    })

    await expect(policy(dir)).resolves.toEqual({
      ok: false,
      reason: 'plugin.lifecycle.install_record_required',
    })

    await writeFile(
      path.join(dir, '_install.json'),
      JSON.stringify({
        version: 1,
        pluginId: 'test.plugin',
        source: {
          type: 'local',
          url: `local:${'a'.repeat(64)}`,
          bundleSha256: 'b'.repeat(64),
          recordedAt: 1,
        },
        grants: {},
        consentSnapshot: {
          permissions: [],
          optionalPermissions: [],
          invokesCommands: [],
          publicCommands: {},
          requestedHeapMB: 32,
          enginesMotrix: '>=2.0.0',
          hostPermissions: [],
        },
      })
    )
    await expect(policy(dir)).resolves.toEqual({ ok: true })
  })

  it('allows explicitly managed unpacked plugin directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-plugin-policy-'))
    cleanup.push(root)
    const dir = path.join(root, 'test.plugin')
    await mkdir(dir)
    const policy = createServerCommunityPluginPolicy({
      allowUnmanagedPlugins: true,
    })
    await expect(policy(dir)).resolves.toEqual({ ok: true })
  })
})
