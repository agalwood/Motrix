import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('parses large binary keys and paths under a constrained heap without changing budgets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'torrent-memory-'))
  try {
    await build({
      entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'es2022',
      outfile: path.join(directory, 'core.mjs'),
    })
    await writeFile(
      path.join(directory, 'probe.mjs'),
      `
import assert from 'node:assert/strict'
import { decode, encode, parseTorrent } from './core.mjs'
const key = new Uint8Array(2 * 1024 * 1024).fill(255)
const info = { name: 'a', length: 1, 'piece length': 16384, pieces: new Uint8Array(20) }
const metadata = encode(new Map([['info', info], [key, 7n]]))
const parsed = parseTorrent(metadata)
assert.equal(parsed.metainfo.get(key), 7n)
assert.equal(parsed.metainfo.entries[1][0].buffer, metadata.buffer)
assert.equal(parsed.infoBytes.buffer, metadata.buffer)
assert.throws(() => decode(metadata, { maxBytes: metadata.length - 1 }), { code: 'limit' })
assert.throws(() => decode(metadata, { maxStringBytes: key.length - 1 }), { code: 'limit' })
const rawPath = new Uint8Array(key.length).fill(97)
const fileBytes = encode({ info: { name: 'root', files: [{ length: 1, path: [rawPath] }], 'piece length': 16384, pieces: new Uint8Array(20) } })
const files = parseTorrent(fileBytes).v1.files
assert.equal(files[0].path[0].length, rawPath.length)
assert.equal(files[0].path[0].buffer, fileBytes.buffer)
// A long flat v1 path must not build a string for each ancestor prefix.
const deepPath = Array.from({ length: 20000 }, () => new Uint8Array([97]))
const deep = parseTorrent(encode({ info: { name: 'root', files: [{ length: 0, path: deepPath }], 'piece length': 16384, pieces: new Uint8Array() } }))
assert.equal(deep.v1.files[0].path.length, deepPath.length)
console.log('large keys and paths verified')
`
    )
    const result = spawnSync(
      process.execPath,
      ['--max-old-space-size=64', path.join(directory, 'probe.mjs')],
      {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 65536,
      }
    )
    expect({
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stderr: result.stderr,
    }).toEqual({ status: 0, signal: null, error: undefined, stderr: '' })
    expect(result.stdout).toContain('large keys and paths verified')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)
