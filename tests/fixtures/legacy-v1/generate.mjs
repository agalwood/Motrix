import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { gzipSync } from 'node:zlib'

// Requires only Git, Node, and the executable bundled in the local v1.8.19 tag.
// No current engine binary or real Motrix profile participates in generation.
const tag = 'v1.8.19'
const commit = 'a0a1fe90f7e9f6d305ed2b512f62c8d36c2fb95a'
const directory = path.dirname(fileURLToPath(import.meta.url))
const repository = path.resolve(directory, '../../..')
const platform = process.platform
const architecture = process.arch
if (platform !== 'darwin' || architecture !== 'arm64') {
  throw new Error(
    'This pinned fixture generator requires darwin/arm64; fixtures are platform-neutral after normalization'
  )
}
const binaryPath = 'extra/darwin/arm64/engine/aria2c'
const binarySha256 =
  '1527c4d071c16c1266880e93750e385cdd4e9d2a950d7f56cb5a21125e3bd311'
const git = (...args) =>
  execFileSync('git', args, { cwd: repository, maxBuffer: 16 * 1024 * 1024 })
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
if (git('rev-parse', tag).toString().trim() !== commit)
  throw new Error('Unexpected legacy tag commit')
const binary = git('show', `${tag}:${binaryPath}`)
if (sha256(binary) !== binarySha256)
  throw new Error('Unexpected legacy bundled binary digest')
const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-v1-generated-'))
const profile = path.join(root, 'profile')
// Motrix normally puts its profile and downloads in separate directories.
const downloads = path.join(root, 'downloads')
await mkdir(downloads, { recursive: true })
await mkdir(profile)
const executable = path.join(root, 'aria2c')
await writeFile(executable, binary)
await chmod(executable, 0o700)
const version = execFileSync(executable, ['--version'], {
  encoding: 'utf8',
}).split('\n')[0]
const configurationPath = 'src/main/core/ConfigManager.js'
const source = git('show', `${tag}:${configurationPath}`).toString()
const defaults = [...source.matchAll(/defaults: (\{[\s\S]*?\n {6}\})/g)]
if (defaults.length !== 2)
  throw new Error('Legacy ConfigManager defaults changed')
const constantsSource = git('show', `${tag}:src/shared/constants.js`).toString()
const uaSource = git('show', `${tag}:src/shared/ua.js`).toString()
const stringConstant = (name) => {
  const match = new RegExp(`export const ${name} = '([^']*)'`).exec(
    `${constantsSource}\n${uaSource}`
  )
  if (!match) throw new Error(`Missing legacy constant ${name}`)
  return match[1]
}
const context = {
  EMPTY_STRING: '',
  IP_VERSION: { V4: 4, V6: 6 },
  APP_THEME: { AUTO: 'auto' },
  APP_RUN_MODE: { STANDARD: 1 },
  CHROME_UA: stringConstant('CHROME_UA'),
  NGOSANG_TRACKERS_BEST_IP_URL_CDN: stringConstant(
    'NGOSANG_TRACKERS_BEST_IP_URL_CDN'
  ),
  NGOSANG_TRACKERS_BEST_URL_CDN: stringConstant(
    'NGOSANG_TRACKERS_BEST_URL_CDN'
  ),
  getDhtPath: (version) =>
    path.join(profile, version === 4 ? 'dht.dat' : 'dht6.dat'),
  getUserDownloadsPath: () => downloads,
  getMaxConnectionPerServer: () => 64,
  app: { getLocale: () => 'en-US' },
  is: { macOS: () => true, windows: () => false, linux: () => false },
}
const system = vm.runInNewContext(`(${defaults[0][1]})`, context, {
  timeout: 1000,
})
const user = vm.runInNewContext(`(${defaults[1][1]})`, context, {
  timeout: 1000,
})
const normalize = (text) =>
  text
    .replaceAll(profile, '__FIXTURE_ROOT__')
    .replaceAll(downloads, '__FIXTURE_DOWNLOADS__')
await writeFile(
  path.join(profile, 'system.json'),
  JSON.stringify(system, null, 2)
)
await writeFile(path.join(profile, 'user.json'), JSON.stringify(user, null, 2))
const conf = git('show', `${tag}:extra/darwin/arm64/engine/aria2.conf`)
await writeFile(path.join(root, 'aria2.conf'), conf)

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))
const payload = Buffer.alloc(4 * 1024 * 1024)
for (let index = 0; index < payload.length; index++)
  payload[index] = index % 251
const server = createServer((request, response) => {
  if (request.url === '/announce') {
    response.end('d8:intervali3600e5:peers0:e')
    return
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range?.[2]
    ? Math.min(Number(range[2]), payload.length - 1)
    : payload.length - 1
  response.writeHead(range ? 206 : 200, {
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    ETag: '"fixture-v1-stable"',
    'Last-Modified': 'Mon, 01 May 2023 00:00:00 GMT',
    ...(range
      ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` }
      : {}),
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  let cursor = start
  const timer = setInterval(() => {
    const next = Math.min(cursor + 65536, end + 1)
    response.write(payload.subarray(cursor, next))
    cursor = next
    if (cursor > end) {
      clearInterval(timer)
      response.end()
    }
  }, 20)
  response.on('close', () => clearInterval(timer))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const httpPort = server.address().port
const reserve = createServer()
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve))
const rpcPort = reserve.address().port
await new Promise((resolve) => reserve.close(resolve))
let engine
let engineExit
let engineLog = ''
const rpc = async (method, ...params) => {
  const response = await fetch(`http://127.0.0.1:${rpcPort}/jsonrpc`, {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: method,
      method: `aria2.${method}`,
      params: ['token:fixture-only', ...params],
    }),
    signal: AbortSignal.timeout(2000),
  })
  const body = await response.json()
  if (body.error) throw new Error(JSON.stringify(body.error))
  return body.result
}
const waitFor = async (operation) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const value = await operation()
      if (value) return value
    } catch {}
    await sleep(50)
  }
  throw new Error(`Legacy engine fixture timed out\n${engineLog}`)
}
const bencode = (value) => {
  if (Buffer.isBuffer(value))
    return Buffer.concat([Buffer.from(`${value.length}:`), value])
  if (typeof value === 'string') return bencode(Buffer.from(value))
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (Array.isArray(value))
    return Buffer.concat([
      Buffer.from('l'),
      ...value.map(bencode),
      Buffer.from('e'),
    ])
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(value)
      .sort()
      .flatMap((key) => [bencode(key), bencode(value[key])]),
    Buffer.from('e'),
  ])
}
try {
  const argumentsList = [
    `--conf-path=${path.join(root, 'aria2.conf')}`,
    `--save-session=${path.join(profile, 'download.session')}`,
    ...Object.entries(system)
      .filter(([, value]) => value !== '')
      .map(([key, value]) => `--${key}=${value}`),
    `--rpc-listen-port=${rpcPort}`,
    '--rpc-listen-all=false',
    '--rpc-secret=fixture-only',
    '--enable-dht=false',
    '--enable-dht6=false',
    '--bt-enable-lpd=false',
    '--enable-peer-exchange=false',
    '--no-netrc=true',
    '--save-session-interval=0',
    '--auto-save-interval=0',
    '--max-concurrent-downloads=2',
  ]
  engine = spawn(executable, argumentsList, {
    cwd: profile,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  engineExit = new Promise((resolve, reject) => {
    engine.once('exit', resolve)
    engine.once('error', reject)
  })
  engine.stdout.on('data', (bytes) => {
    engineLog += bytes.toString()
  })
  engine.stderr.on('data', (bytes) => {
    engineLog += bytes.toString()
  })
  await waitFor(() => rpc('getVersion'))
  const uri = `http://127.0.0.1:${httpPort}/partial.bin`
  const httpGid = await rpc(
    'addUri',
    [uri, `http://127.0.0.1:${httpPort}/mirror.bin`],
    {
      gid: '0123456789abcdef',
      dir: downloads,
      out: 'partial.bin',
      pause: 'false',
      split: '1',
      'max-connection-per-server': '1',
    }
  )
  const httpStatus = await waitFor(async () => {
    const status = await rpc('tellStatus', httpGid)
    return Number(status.completedLength) >= 1500000 &&
      status.status === 'active'
      ? status
      : null
  })
  await rpc('forcePause', httpGid)
  const httpPaused = await waitFor(async () => {
    const status = await rpc('tellStatus', httpGid)
    return status.status === 'paused' ? status : null
  })
  const info = {
    name: 'fixture-bundle',
    private: 1,
    'piece length': 16384,
    files: [
      { length: 16384, path: ['first.bin'] },
      { length: 16384, path: ['second.bin'] },
    ],
    pieces: Buffer.concat([
      createHash('sha1').update(Buffer.alloc(16384, 1)).digest(),
      createHash('sha1').update(Buffer.alloc(16384, 2)).digest(),
    ]),
  }
  const torrent = bencode({
    announce: `http://127.0.0.1:${httpPort}/announce`,
    info,
  })
  const infoHash = createHash('sha1').update(bencode(info)).digest('hex')
  const btGid = await rpc('addTorrent', torrent.toString('base64'), [], {
    gid: 'fedcba9876543210',
    dir: downloads,
    pause: 'false',
    'select-file': '1',
    'seed-time': '0',
    'bt-tracker': '',
    'bt-save-metadata': 'true',
  })
  await waitFor(
    async () => (await rpc('tellStatus', btGid)).status === 'active'
  )
  await sleep(250)
  await rpc('forcePause', btGid)
  const btPaused = await waitFor(async () => {
    const status = await rpc('tellStatus', btGid)
    return status.status === 'paused' ? status : null
  })
  await rpc(
    'addUri',
    [
      'magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=fixture-magnet',
    ],
    {
      gid: '1111222233334444',
      dir: downloads,
      pause: 'true',
    }
  )
  await rpc('saveSession')
  await rpc('shutdown')
  await engineExit
  engine = null
  const output = path.join(directory, 'generated')
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  const session = await readFile(path.join(profile, 'download.session'), 'utf8')
  await mkdir(path.join(output, 'profile'))
  await writeFile(
    path.join(output, 'profile', 'download.session'),
    normalize(session).replaceAll(String(httpPort), '__FIXTURE_HTTP_PORT__')
  )
  await writeFile(
    path.join(output, 'profile', 'system.json'),
    `${normalize(JSON.stringify(system, null, 2))}\n`
  )
  await writeFile(
    path.join(output, 'profile', 'user.json'),
    `${JSON.stringify(user, null, 2)}\n`
  )
  const files = []
  const visit = async (dir) => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const filename = path.join(dir, item.name)
      if (item.isDirectory()) await visit(filename)
      else if (item.name.endsWith('.aria2') || item.name.endsWith('.torrent')) {
        const bytes = await readFile(filename)
        const relative = path.relative(root, filename)
        const target = path.join(output, relative)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, bytes)
        files.push({
          path: relative,
          sha256: sha256(bytes),
          bytes: bytes.length,
        })
      }
    }
  }
  await visit(profile)
  await visit(downloads)
  if (!files.some((file) => file.path.endsWith('partial.bin.aria2')))
    throw new Error('Missing real partial HTTP control file')
  if (!files.some((file) => file.path.endsWith('fixture-bundle.aria2')))
    throw new Error('Missing real BT control file')
  const metadataDigest = createHash('sha1').update(torrent).digest('hex')
  if (!files.some((file) => file.path.endsWith(`${metadataDigest}.torrent`)))
    throw new Error('Missing engine-saved RPC torrent')
  const partial = await readFile(path.join(downloads, 'partial.bin'))
  await writeFile(
    path.join(output, 'downloads', 'partial.bin.gz'),
    gzipSync(partial)
  )
  await writeFile(
    path.join(output, 'provenance.json'),
    `${JSON.stringify(
      {
        tag,
        commit,
        binaryPath,
        binarySha256,
        binaryGitObject: git('rev-parse', `${tag}:${binaryPath}`)
          .toString()
          .trim(),
        version,
        sourceConfigSha256: sha256(source),
        generation:
          'The tagged v1 bundled engine generated download.session, .aria2 control files and saved RPC .torrent files. Config JSON is source-derived ConfigManager defaults, not a full old Electron application run.',
        normalization:
          'Only profile/download path prefixes and HTTP port in text files are replaced with fixture placeholders. Downloads are siblings of the profile, as in a normal installation. Control and torrent bytes are unmodified. Saved partial HTTP payload is gzip-compressed without altering its uncompressed bytes.',
        safety:
          'Disposable profile, local range HTTP server and tracker only; DHT, PEX and LPD disabled. No real user profiles or external download endpoints.',
        http: {
          gid: httpGid,
          completedLengthAtPauseRequest: httpStatus.completedLength,
          totalLength: httpStatus.totalLength,
          payloadSha256: sha256(payload),
          payloadRecipe: '4194304 bytes; byte at zero-based index i is i % 251',
          checkpointStatus: {
            completedLength: httpPaused.completedLength,
            totalLength: httpPaused.totalLength,
            pieceLength: httpPaused.pieceLength,
            numPieces: httpPaused.numPieces,
            bitfield: httpPaused.bitfield,
            files: httpPaused.files.map(
              ({
                index,
                path: filename,
                length,
                completedLength,
                selected,
              }) => ({
                index,
                path: normalize(filename),
                length,
                completedLength,
                selected,
              })
            ),
          },
          savedPayloadBytes: partial.length,
          savedPayloadSha256: sha256(partial),
          savedPayloadGzip: 'downloads/partial.bin.gz',
        },
        bt: {
          gid: btGid,
          infoHash,
          metadataFilename: `${metadataDigest}.torrent`,
          selectedFiles: [1],
          private: true,
          checkpointStatus: {
            completedLength: btPaused.completedLength,
            totalLength: btPaused.totalLength,
            pieceLength: btPaused.pieceLength,
            numPieces: btPaused.numPieces,
            bitfield: btPaused.bitfield,
            files: btPaused.files.map(
              ({
                index,
                path: filename,
                length,
                completedLength,
                selected,
              }) => ({
                index,
                path: normalize(filename),
                length,
                completedLength,
                selected,
              })
            ),
          },
        },
        files,
      },
      null,
      2
    )}\n`
  )
  console.log(JSON.stringify({ version, output, files }, null, 2))
} finally {
  if (engine) {
    engine.kill('SIGKILL')
    await engineExit
  }
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
