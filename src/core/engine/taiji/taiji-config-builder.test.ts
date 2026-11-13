import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_ENGINE_SETTINGS } from '@shared/schemas/engine-settings'
import { describe, expect, it } from 'vitest'
import { TaijiConfigBuilder } from './taiji-config-builder'

describe('taiji configuration isolation', () => {
  it('preserves legacy configuration and always selects its own session database', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'motrix-taiji-config-'))
    try {
      await writeFile(
        path.join(directory, 'aria2.conf'),
        'unknown-taiji-option=true\n'
      )
      await writeFile(path.join(directory, 'aria2.db'), 'legacy database')
      const builder = new TaijiConfigBuilder(directory)
      await builder.prepare()
      const args = builder.buildNativeArgs(
        {
          ...DEFAULT_ENGINE_SETTINGS,
          rpcSecret: 'secret',
          sqlite3DbPath: '/legacy/custom.db',
        },
        { download: 123, upload: 456 },
        '/downloads'
      )
      expect(args).toContain(
        `--sqlite3-db-path=${path.join(directory, 'taiji.sqlite3')}`
      )
      expect(args).toContain('--max-overall-download-limit=123')
      expect(args).toContain('--rpc-aria2-compat=false')
      expect(
        args.some(
          (arg) =>
            arg.startsWith('--conf-path=') || arg.startsWith('--input-file=')
        )
      ).toBe(false)
      expect(await readFile(path.join(directory, 'aria2.db'), 'utf8')).toBe(
        'legacy database'
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects missing credentials and invalid argument boundaries', () => {
    const builder = new TaijiConfigBuilder('/tmp/profile')
    expect(() =>
      builder.buildNativeArgs(
        { ...DEFAULT_ENGINE_SETTINGS, rpcSecret: '' },
        { download: 0, upload: 0 },
        '/tmp'
      )
    ).toThrow('RPC secret')
    expect(() =>
      builder.buildNativeArgs(
        { ...DEFAULT_ENGINE_SETTINGS, rpcSecret: 'secret' },
        { download: 0, upload: 0 },
        '/tmp\nother'
      )
    ).toThrow('CR, LF or NUL')
  })
})
