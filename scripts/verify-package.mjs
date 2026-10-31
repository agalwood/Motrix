import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const npmCli = [
  path.resolve(
    path.dirname(process.execPath),
    '../lib/node_modules/npm/bin/npm-cli.js'
  ),
  path.resolve(
    path.dirname(process.execPath),
    'node_modules/npm/bin/npm-cli.js'
  ),
].find(existsSync)
assert.ok(npmCli, 'npm CLI must be installed alongside Node.js')
const npm = (args, cwd) =>
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
const temporary = await mkdtemp(path.join(tmpdir(), 'motrix-torrent-package-'))
try {
  const [packed] = JSON.parse(
    npm(
      ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary],
      root
    )
  )
  assert.equal(packed.name, '@motrix/torrent')
  for (const { path: file } of packed.files) {
    assert.ok(
      /^(dist\/[^/]+\.(?:js|d\.ts)|package\.json|LICENSE|README(?:\.zh-CN)?\.md|CHANGELOG\.md)$/.test(
        file
      ),
      `Unexpected published file: ${file}`
    )
  }
  const consumer = path.join(temporary, 'consumer')
  await mkdir(consumer)
  await writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  )
  npm(
    [
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--package-lock=false',
      '--no-audit',
      '--no-fund',
      path.join(temporary, packed.filename),
    ],
    consumer
  )
  const script = `
import assert from 'node:assert/strict'
import { encode, decode, parseTorrent, parseMagnet } from '@motrix/torrent'
import { encode as encodeBencode } from '@motrix/torrent/bencode'
import { normalizeBtih } from '@motrix/torrent/magnet'
const info = { name: 'consumer', length: 0, 'piece length': 16384, pieces: new Uint8Array() }
const bytes = encode({ info })
assert.equal(parseTorrent(bytes).identity.kind, 'v1')
assert.equal(decode(encodeBencode(9007199254740993n)).value, 9007199254740993n)
assert.equal(parseMagnet('magnet:?xt=urn:btmh:1220' + 'ab'.repeat(32)).identity.kind, 'v2')
assert.equal(normalizeBtih('AB'.repeat(20)), 'ab'.repeat(20))
`
  await writeFile(path.join(consumer, 'consumer.mjs'), script)
  execFileSync(process.execPath, ['consumer.mjs'], {
    cwd: consumer,
    stdio: 'inherit',
  })
  const installed = JSON.parse(
    await readFile(
      path.join(consumer, 'node_modules/@motrix/torrent/package.json'),
      'utf8'
    )
  )
  assert.deepEqual(Object.keys(installed.dependencies), ['@noble/hashes'])
  assert.ok(!existsSync(path.join(consumer, 'node_modules/parse-torrent')))
  await mkdir(path.join(root, 'output/package'), { recursive: true })
  await copyFile(
    path.join(temporary, packed.filename),
    path.join(root, 'output/package', packed.filename)
  )
  console.log(
    `Verified ${packed.name}@${packed.version}: ${packed.files.length} files, ${packed.size} packed bytes, all ESM subpaths`
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
