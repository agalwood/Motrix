#!/usr/bin/env node
// scripts/fetch-engine.mjs
//
// Fetch the bundled aria2 binary from a pinned `motrixapp/aria2` GitHub
// Release, verify it against an in-repo lockfile, and place it at exactly the
// path the runtime resolves (`extra/<platform>/<arch>/<aria2c|aria2c.exe>`).
//
// Runs on plain Node 20 with NO loader and NO TypeScript — it is wired into
// `postinstall`, which executes before any build tooling exists. The path
// logic below mirrors the host-owned resource layout and the pure binary-name
// rule in `@shared/platform/aria2.ts` (a `.mjs` cannot import the `@shared`
// alias or a `.ts` source at runtime). The path-parity test guards this copy
// against drift.

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const EXTRA_DIR = path.join(REPO_ROOT, 'extra')
const LOCK_PATH = path.join(SCRIPT_DIR, 'engine.lock.json')
const DEFAULT_REPO = 'motrixapp/aria2'
// Engine identifier recorded in the lockfile. This fetch tooling is
// engine-agnostic by name; today it is configured for aria2. A future
// self-built engine gets its own lockfile/config rather than a branch here.
const ENGINE = 'aria2'
const GITHUB = 'https://github.com'

export const EXIT_OK = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2
export const EXIT_UNSUPPORTED_HOST = 3

// Per-request download timeout + transient-failure retry policy. The timeout
// is overridable via env so a slow/constrained network can widen it without a
// code change. A tampered digest is NOT retried — that is a hard fail in
// installAsset; retries here only cover transient network/5xx conditions.
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 3
const DEFAULT_BACKOFF_MS = 500

function resolveTimeoutMs() {
  const raw = Number(process.env.MOTRIX_ENGINE_FETCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS
}

// Desktop targets only — android is a non-goal (electron-builder ships
// mac/win/linux). `releaseArch` is the arch label inside the release asset
// filename; note linux `arm` (Node arch) maps to `armv7l` (release label).
// `key` is Node's `${process.platform}-${process.arch}`.
const DESKTOP_TARGETS = [
  { key: 'darwin-arm64', os: 'darwin', releaseArch: 'arm64', ext: 'tar.gz' },
  { key: 'darwin-x64', os: 'darwin', releaseArch: 'x64', ext: 'tar.gz' },
  { key: 'win32-x64', os: 'win32', releaseArch: 'x64', ext: 'zip' },
  { key: 'win32-ia32', os: 'win32', releaseArch: 'ia32', ext: 'zip' },
  { key: 'linux-x64', os: 'linux', releaseArch: 'x64', ext: 'tar.gz' },
  { key: 'linux-arm64', os: 'linux', releaseArch: 'arm64', ext: 'tar.gz' },
  { key: 'linux-arm', os: 'linux', releaseArch: 'armv7l', ext: 'tar.gz' },
]

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

// INLINE copy of `@shared/platform/aria2.ts::aria2BinaryName` — see file header.
export function binaryName(platform) {
  return platform === 'win32' ? 'aria2c.exe' : 'aria2c'
}

// Host-owned resource layout mirror — see file header.
export function bundledPath(extraDir, platform, arch) {
  return path.join(extraDir, platform, arch, binaryName(platform))
}

export function resolveHostKey(platform, arch) {
  return `${platform}-${arch}`
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function verifyDigest(bytes, expected) {
  return sha256Hex(bytes) === String(expected).toLowerCase()
}

// Parse a `sha256sum`-style file into Map<filename, lowercaseHexDigest>.
// Accepts both `<hash>  <file>` and the `<hash> *<file>` binary-mode marker.
export function parseSha256Sums(text) {
  const map = new Map()
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (match) map.set(match[2], match[1].toLowerCase())
  }
  return map
}

export function parseArgs(argv) {
  const args = {
    writeLock: false,
    tag: undefined,
    all: false,
    platform: undefined,
    arch: undefined,
    force: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    let flag = token
    let inlineValue
    const eq = token.startsWith('--') ? token.indexOf('=') : -1
    if (eq !== -1) {
      flag = token.slice(0, eq)
      inlineValue = token.slice(eq + 1)
    }
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`flag ${flag} requires a value`)
      }
      i += 1
      return next
    }
    switch (flag) {
      case '--write-lock':
        args.writeLock = true
        break
      case '--all':
        args.all = true
        break
      case '--force':
        args.force = true
        break
      case '--tag':
        args.tag = readValue()
        break
      case '--platform':
        args.platform = readValue()
        break
      case '--arch':
        args.arch = readValue()
        break
      default:
        throw new Error(`unknown flag: ${token}`)
    }
  }
  return args
}

// Turn parsed args + host into the list of lockfile keys to process. Host mode
// (no selector flags) resolves the single host key — its absence is handled as
// a soft condition in `run`, not here.
export function selectKeys(lock, args, host) {
  const available = Object.keys(lock.assets)
  if (args.all) return available

  const requireKey = (key) => {
    if (!lock.assets[key]) {
      throw new Error(`no prebuilt aria2 binary for ${key} in the lockfile`)
    }
    return [key]
  }

  if (args.platform && args.arch) {
    return requireKey(`${args.platform}-${args.arch}`)
  }
  if (args.platform) {
    const prefix = `${args.platform}-`
    const keys = available.filter((key) => key.startsWith(prefix))
    if (keys.length === 0) {
      throw new Error(`no aria2 assets for platform ${args.platform}`)
    }
    return keys
  }
  if (args.arch) {
    return requireKey(`${host.platform}-${args.arch}`)
  }
  return requireKey(resolveHostKey(host.platform, host.arch))
}

// ---------------------------------------------------------------------------
// Side effects (injectable so tests can stub network / fs / extract)
// ---------------------------------------------------------------------------

// GET `url` with a per-attempt AbortController timeout and a small
// exponential-ish backoff retry for transient failures (network error, 5xx,
// 429). A non-transient 4xx (e.g. 404 wrong tag/asset) fails fast — retrying
// it only delays a certain failure. Injectable `io` (fetch/sleep/timeout/
// retries) keeps it unit-testable with no real network.
export async function fetchWithRetry(url, io = {}) {
  const fetchFn = io.fetch ?? fetch
  const timeoutMs = io.timeoutMs ?? resolveTimeoutMs()
  const retries = io.retries ?? DEFAULT_RETRIES
  const backoffMs = io.backoffMs ?? DEFAULT_BACKOFF_MS
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  let lastError
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchFn(url, {
        redirect: 'follow',
        signal: controller.signal,
      })
      if (res.ok) return Buffer.from(await res.arrayBuffer())
      lastError = new Error(`HTTP ${res.status} ${res.statusText}`)
      // 4xx (other than 429) is not transient — stop immediately.
      if (res.status < 500 && res.status !== 429) break
    } catch (err) {
      lastError = err
    } finally {
      clearTimeout(timer)
    }
    if (attempt < retries) await sleep(attempt * backoffMs)
  }
  throw new Error(
    `GET ${url} failed after ${retries} attempt(s): ` +
      `${lastError?.message ?? lastError}`
  )
}

function downloadBytes(url) {
  return fetchWithRetry(url)
}

let unzipAvailable
function hasUnzip() {
  if (unzipAvailable === undefined) {
    unzipAvailable = !spawnSync('unzip', ['-v'], { stdio: 'ignore' }).error
  }
  return unzipAvailable
}

// Pick the extraction command by archive extension. GNU tar (Linux) CANNOT
// read a `.zip`, so zip assets prefer `unzip`; only when unzip is absent do we
// fall back to `tar -xf` (bsdtar on macOS/Windows auto-detects zip — the
// Linux-GNU-tar fallback is best-effort for cross-platform packaging). `.tar.gz`
// always uses `tar -xzf`, which both GNU tar and bsdtar handle.
export function resolveExtractCommand(archivePath, destDir, opts = {}) {
  if (archivePath.toLowerCase().endsWith('.zip')) {
    if (opts.unzipAvailable) {
      return { command: 'unzip', args: ['-o', archivePath, '-d', destDir] }
    }
    return { command: 'tar', args: ['-xf', archivePath, '-C', destDir] }
  }
  return { command: 'tar', args: ['-xzf', archivePath, '-C', destDir] }
}

// Extraction targets a temp dir; only the single binary entry is promoted
// afterward. `io` (spawn/unzipAvailable) is injectable for tests.
export function extractArchive(archivePath, destDir, io = {}) {
  const spawnFn = io.spawn ?? spawn
  const unzip = io.unzipAvailable ?? hasUnzip()
  const { command, args } = resolveExtractCommand(archivePath, destDir, {
    unzipAvailable: unzip,
  })
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`))
    })
  })
}

async function readLockFile() {
  if (!existsSync(LOCK_PATH)) return null
  return JSON.parse(await readFile(LOCK_PATH, 'utf8'))
}

async function writeLockFileAtomic(lock) {
  const json = `${JSON.stringify(lock, null, 2)}\n`
  const staging = `${LOCK_PATH}.tmp-${randomBytes(6).toString('hex')}`
  await writeFile(staging, json)
  await rename(staging, LOCK_PATH)
}

export const defaultDeps = {
  download: downloadBytes,
  extract: extractArchive,
  readFile: (p) => readFile(p),
  writeFile: (p, data) => writeFile(p, data),
  rename: (from, to) => rename(from, to),
  chmod: (p, mode) => chmod(p, mode),
  mkdir: (p) => mkdir(p, { recursive: true }),
  mkdtemp: (prefix) => mkdtemp(path.join(tmpdir(), prefix)),
  rm: (p) => rm(p, { recursive: true, force: true }),
  fileExists: (p) => existsSync(p),
  randomId: () => randomBytes(6).toString('hex'),
  readLock: readLockFile,
  writeLockFile: writeLockFileAtomic,
  host: () => ({ platform: process.platform, arch: process.arch }),
  extraDir: () => EXTRA_DIR,
  log: (...parts) => console.log(...parts),
  logError: (...parts) => console.error(...parts),
}

// ---------------------------------------------------------------------------
// Install flow
// ---------------------------------------------------------------------------

// Download, verify, extract, and atomically place one asset. Returns
// 'skipped' when the target already matches `binarySha256`, else 'installed'.
export async function installAsset(ctx, deps = defaultDeps) {
  const { key, asset, repo, tag, extraDir, force } = ctx
  const dash = key.indexOf('-')
  const platform = key.slice(0, dash)
  const arch = key.slice(dash + 1)
  const target = bundledPath(extraDir, platform, arch)
  const expectedBinary = String(asset.binarySha256).toLowerCase()

  // Idempotency skip: compare the INSTALLED binary against `binarySha256`
  // (the extracted-binary digest), NOT the archive digest.
  if (!force && deps.fileExists(target)) {
    const current = sha256Hex(await deps.readFile(target))
    if (current === expectedBinary) {
      deps.log(`[fetch-engine] ${key}: ${asset.bin} up to date — skipping`)
      return 'skipped'
    }
  }

  const url = `${GITHUB}/${repo}/releases/download/${tag}/${asset.file}`
  deps.log(`[fetch-engine] ${key}: downloading ${asset.file}`)
  const archiveBytes = await deps.download(url)
  if (!verifyDigest(archiveBytes, asset.archiveSha256)) {
    throw new Error(
      'archive digest mismatch\n' +
        `  file:     ${asset.file}\n` +
        `  url:      ${url}\n` +
        `  expected: ${String(asset.archiveSha256).toLowerCase()}\n` +
        `  actual:   ${sha256Hex(archiveBytes)}`
    )
  }

  const workDir = await deps.mkdtemp('aria2-fetch-')
  // Tracked outside the try so a chmod/rename failure can't leak the staging
  // temp file (it lives in the target dir, not workDir). After a successful
  // rename it no longer exists and the finally rm is a harmless no-op.
  let staging
  try {
    const archivePath = path.join(workDir, asset.file)
    await deps.writeFile(archivePath, archiveBytes)
    await deps.extract(archivePath, workDir)

    const extractedBin = path.join(workDir, asset.bin)
    if (!deps.fileExists(extractedBin)) {
      throw new Error(`archive ${asset.file} did not contain ${asset.bin}`)
    }
    const binBytes = await deps.readFile(extractedBin)
    const binDigest = sha256Hex(binBytes)
    if (binDigest !== expectedBinary) {
      throw new Error(
        'binary digest mismatch\n' +
          `  binary:   ${asset.bin} (from ${asset.file})\n` +
          `  expected: ${expectedBinary}\n` +
          `  actual:   ${binDigest}`
      )
    }

    const targetDir = path.dirname(target)
    await deps.mkdir(targetDir)
    // Stage inside the target directory so the final rename is atomic on the
    // same filesystem (a temp dir may live on a different volume).
    staging = path.join(targetDir, `.${asset.bin}.tmp-${deps.randomId()}`)
    await deps.writeFile(staging, binBytes)
    if (platform !== 'win32') await deps.chmod(staging, 0o755)
    await deps.rename(staging, target)
    deps.log(`[fetch-engine] ${key}: installed ${asset.bin} -> ${target}`)
    return 'installed'
  } finally {
    await deps.rm(workDir)
    if (staging) await deps.rm(staging)
  }
}

// ---------------------------------------------------------------------------
// --write-lock: rebuild the whole lockfile from a release (the only path that
// pins digests + version-stamped filenames into the repo).
// ---------------------------------------------------------------------------

export async function runWriteLock(args, existing, deps = defaultDeps) {
  const repo = existing?.repo ?? DEFAULT_REPO
  const tag = args.tag ?? existing?.tag
  if (!tag) {
    deps.logError(
      '[fetch-engine] --write-lock needs --tag when no lockfile exists'
    )
    return EXIT_USAGE
  }
  const version = tag.replace(/^v/, '')

  const sumsUrl = `${GITHUB}/${repo}/releases/download/${tag}/SHA256SUMS`
  deps.log(`[fetch-engine] write-lock: fetching SHA256SUMS for ${tag}`)
  const sums = parseSha256Sums((await deps.download(sumsUrl)).toString('utf8'))

  const assets = {}
  for (const target of DESKTOP_TARGETS) {
    const bin = binaryName(target.os)
    const file = `aria2c-${version}-${target.os}-${target.releaseArch}.${target.ext}`
    const archiveSha256 = sums.get(file)
    if (!archiveSha256) {
      deps.logError(`[fetch-engine] SHA256SUMS is missing ${file}`)
      return EXIT_FAILURE
    }
    const url = `${GITHUB}/${repo}/releases/download/${tag}/${file}`
    deps.log(`[fetch-engine] write-lock: ${target.key} <- ${file}`)
    const archiveBytes = await deps.download(url)
    if (!verifyDigest(archiveBytes, archiveSha256)) {
      deps.logError(
        `[fetch-engine] archive digest mismatch for ${file} — refusing lock`
      )
      return EXIT_FAILURE
    }
    const workDir = await deps.mkdtemp('aria2-lock-')
    try {
      const archivePath = path.join(workDir, file)
      await deps.writeFile(archivePath, archiveBytes)
      await deps.extract(archivePath, workDir)
      const extractedBin = path.join(workDir, bin)
      if (!deps.fileExists(extractedBin)) {
        deps.logError(`[fetch-engine] ${file} did not contain ${bin}`)
        return EXIT_FAILURE
      }
      const binarySha256 = sha256Hex(await deps.readFile(extractedBin))
      assets[target.key] = { file, bin, archiveSha256, binarySha256 }
    } finally {
      await deps.rm(workDir)
    }
  }

  // Validate before writing: every desktop target present, every filename
  // embeds the top-level version (so a tag bump can never leave a stale name).
  for (const target of DESKTOP_TARGETS) {
    const record = assets[target.key]
    if (!record) {
      deps.logError(`[fetch-engine] lock is missing desktop key ${target.key}`)
      return EXIT_FAILURE
    }
    if (!record.file.includes(`-${version}-`)) {
      deps.logError(
        `[fetch-engine] ${target.key} file ${record.file} does not embed ` +
          `version ${version}`
      )
      return EXIT_FAILURE
    }
  }

  await deps.writeLockFile({
    engine: existing?.engine ?? ENGINE,
    repo,
    tag,
    version,
    assets,
  })
  deps.log(
    `[fetch-engine] wrote ${LOCK_PATH} for ${tag} ` +
      `(${Object.keys(assets).length} assets)`
  )
  return EXIT_OK
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function run(argv, deps = defaultDeps) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    deps.logError(`[fetch-engine] ${err.message}`)
    return EXIT_USAGE
  }

  if (args.writeLock) {
    return runWriteLock(args, await deps.readLock(), deps)
  }

  const lock = await deps.readLock()
  if (!lock) {
    deps.logError(
      '[fetch-engine] no lockfile — run `node scripts/fetch-engine.mjs ' +
        '--write-lock --tag <tag>` first'
    )
    return EXIT_FAILURE
  }

  const host = deps.host()
  const hostMode = !args.all && !args.platform && !args.arch
  if (hostMode && !lock.assets[resolveHostKey(host.platform, host.arch)]) {
    const hostKey = resolveHostKey(host.platform, host.arch)
    deps.log(
      `[fetch-engine] no prebuilt aria2 binary for this host (${hostKey}) — ` +
        'skipping (this platform is not packaged)'
    )
    return EXIT_UNSUPPORTED_HOST
  }

  let keys
  try {
    keys = selectKeys(lock, args, host)
  } catch (err) {
    deps.logError(`[fetch-engine] ${err.message}`)
    return EXIT_USAGE
  }

  const extraDir = deps.extraDir()
  let failed = false
  for (const key of keys) {
    try {
      await installAsset(
        {
          key,
          asset: lock.assets[key],
          repo: lock.repo,
          tag: lock.tag,
          extraDir,
          force: args.force,
        },
        deps
      )
    } catch (err) {
      deps.logError(`[fetch-engine] ${key}: ${err.message}`)
      failed = true
    }
  }
  if (failed && hostMode) {
    // Actionable guidance for the common install-time failure (offline /
    // restricted network). The per-key error above already carries the URL
    // and reason; here we tell the user how to unblock `pnpm install`.
    deps.logError(
      '[fetch-engine] could not fetch the aria2 binary for this host.\n' +
        '  If you are offline or on a restricted network, set ' +
        'MOTRIX_SKIP_ENGINE_FETCH=1 to skip this step during install, then run ' +
        '`pnpm fetch:engine` later once connectivity is restored.'
    )
  }
  return failed ? EXIT_FAILURE : EXIT_OK
}

// CLI guard — only run when invoked directly, not when imported by tests.
const invokedAsMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedAsMain) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[fetch-engine] fatal: ${err?.stack ?? err}`)
      process.exit(EXIT_FAILURE)
    })
}
