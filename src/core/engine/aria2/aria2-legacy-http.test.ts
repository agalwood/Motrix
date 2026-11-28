// @vitest-environment node
import {
  lstat,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CreateDownloadParams,
  LegacyHttpBindingProof,
} from '../engine-adapter'
import type { Aria2LegacyCheckpoint } from './aria2-legacy-checkpoint'
import {
  pinLegacyHttpOptions,
  verifyLegacyHttpBinding,
} from './aria2-legacy-http'
import { legacyWirePath } from './aria2-legacy-path'
import type { Aria2RpcClient } from './aria2-rpc-client'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'legacy-http-adapter-'))
  )
  roots.push(root)
  const filename = path.join(root, 'partial.bin')
  await writeFile(filename, Buffer.alloc(64), { mode: 0o600 })
  const stat = await lstat(filename, { bigint: true })
  const input: LegacyHttpBindingProof = {
    engineTaskId: '1234567890abcdef',
    saveDir: root,
    targetPath: filename,
    uri: 'https://example.test/file.bin',
    expected: { totalBytes: 128, pieceBytes: 64 },
    entityTag: '"version-1"',
    fileIdentity: { device: String(stat.dev), inode: String(stat.ino) },
  }
  const params: CreateDownloadParams = {
    uris: [input.uri],
    saveDir: root,
    filename: 'partial.bin',
    gid: input.engineTaskId,
    pause: true,
    resumePolicy: 'checkpoint',
    cookies: [],
    legacyCheckpointActivation: {
      token: 'legacy_http_token_1234',
      targetPath: filename,
    },
  }
  const options: Record<string, string | string[]> = {
    'piece-length': '64',
    header: ['If-Match: "version-1"', 'Accept-Encoding: identity'],
    'allow-overwrite': 'true',
    'http-user': 'ambient-secret',
    'http-proxy': 'http://ambient.test',
  }
  const reconcile = vi.fn(async () => ({
    status: 'created',
    engineTaskId: input.engineTaskId,
  }))
  const checkpoint = { reconcile } as unknown as Aria2LegacyCheckpoint
  return { root, filename, input, params, options, reconcile, checkpoint }
}

describe('legacy HTTP dispatch and binding', () => {
  it('pins the original output, checkpoint and request semantics after passthrough', async () => {
    const f = await fixture()
    await pinLegacyHttpOptions(f.params, f.options, f.checkpoint)
    expect(f.options).toMatchObject({
      dir: legacyWirePath(f.root),
      out: 'partial.bin',
      gid: f.input.engineTaskId,
      pause: 'true',
      'always-resume': 'true',
      continue: 'false',
      'allow-overwrite': 'false',
      'auto-file-renaming': 'false',
      'remove-control-file': 'false',
      'file-allocation': 'none',
      'follow-torrent': 'false',
      'follow-metalink': 'false',
      'http-user': '',
      'http-passwd': '',
      'all-proxy': '',
      'http-proxy': '',
      'no-netrc': 'true',
      header: [
        'If-Match: "version-1"',
        'Accept-Encoding: identity',
        'Cookie: ',
      ],
    })
  })

  it.each(['consumed', 'absent', 'wrong-gid'])(
    'does not dispatch from an unowned or consumed receipt: %s',
    async (status) => {
      const f = await fixture()
      f.reconcile.mockResolvedValue({
        status,
        engineTaskId:
          status === 'wrong-gid' ? 'ffffffffffffffff' : f.input.engineTaskId,
      })
      await expect(
        pinLegacyHttpOptions(f.params, f.options, f.checkpoint)
      ).rejects.toThrow('activationUncertain')
    }
  )

  it.each([
    ['missing version', []],
    ['weak version', ['If-Match: W/"version-1"', 'Accept-Encoding: identity']],
    [
      'duplicate version',
      [
        'If-Match: "version-1"',
        'if-match: "other"',
        'Accept-Encoding: identity',
      ],
    ],
    ['encoded response', ['If-Match: "version-1"', 'Accept-Encoding: gzip']],
  ])('rejects %s before native dispatch', async (_label, headers) => {
    const f = await fixture()
    f.options.header = headers
    await expect(
      pinLegacyHttpOptions(f.params, f.options, f.checkpoint)
    ).rejects.toThrow('activationUncertain')
    expect(f.reconcile).not.toHaveBeenCalled()
  })

  it('rejects output relocation', async () => {
    const f = await fixture()
    f.params.filename = 'other.bin'
    await expect(
      pinLegacyHttpOptions(f.params, f.options, f.checkpoint)
    ).rejects.toThrow('activationUncertain')
  })

  it('proves a paused zero-length native row, rejects changed ownership and unsafe options', async () => {
    const f = await fixture()
    await pinLegacyHttpOptions(f.params, f.options, f.checkpoint)
    const raw = {
      gid: f.input.engineTaskId,
      status: 'paused',
      totalLength: '0',
      files: [
        {
          path: legacyWirePath(f.filename),
          length: '0',
          uris: [{ uri: f.input.uri, status: 'waiting' }],
        },
      ],
    }
    const rpc = {
      tellStatus: vi.fn(async () => raw),
      getOption: vi.fn(async () => f.options),
    } as unknown as Aria2RpcClient
    expect(await verifyLegacyHttpBinding(rpc, f.input)).toBe(true)
    raw.files[0].uris.push({ uri: f.input.uri, status: 'used' })
    expect(await verifyLegacyHttpBinding(rpc, f.input)).toBe(true)
    raw.files[0].uris[1].uri = 'https://different.test/file.bin'
    expect(await verifyLegacyHttpBinding(rpc, f.input)).toBe(false)
    raw.files[0].uris.pop()
    f.input.request = {
      headers: {},
      userAgent: 'verified-agent',
      proxy: '',
      noProxy: '',
    }
    f.options['user-agent'] = 'verified-agent'
    f.options.header = `${(f.options.header as string[]).join('\n')}\nAccept: */*\n`
    expect(await verifyLegacyHttpBinding(rpc, f.input)).toBe(true)
    const verifiedHeaders = f.options.header
    f.options.header += 'Authorization: unexpected\n'
    expect(await verifyLegacyHttpBinding(rpc, f.input)).toBe(false)
    f.options.header = verifiedHeaders
    f.options['user-agent'] = 'other-agent'
    expect(await verifyLegacyHttpBinding(rpc, f.input)).toBe(false)
    f.options['user-agent'] = 'verified-agent'
    delete f.input.request
    f.options['allow-overwrite'] = 'true'
    expect(await verifyLegacyHttpBinding(rpc, f.input)).toBe(false)
    f.options['allow-overwrite'] = 'false'
    raw.files[0].uris[0].uri = 'https://other.test/file.bin'
    expect(await verifyLegacyHttpBinding(rpc, f.input)).toBe(false)
    raw.files[0].uris[0].uri = f.input.uri
    f.options.header = ['If-Match: "other"', 'Accept-Encoding: identity']
    expect(await verifyLegacyHttpBinding(rpc, f.input)).toBe(false)
    f.options.header = ['If-Match: "version-1"', 'Accept-Encoding: identity']
    await rename(f.filename, `${f.filename}.original`)
    await writeFile(f.filename, Buffer.alloc(64), { mode: 0o600 })
    expect(await verifyLegacyHttpBinding(rpc, f.input)).toBe(false)
  })
})
