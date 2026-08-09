#!/usr/bin/env node
// scripts/fetch-builtins.mjs
//
// Fetch pinned builtin-plugin .moext artifacts (GitHub Releases of
// motrixapp/builtin-plugins), verify them against scripts/builtins.lock.json,
// and unpack into dist/builtin-plugins/<id>/ — the same layout
// pack-builtins.mjs produces and PluginRegistry.scanInto() expects. Each
// verified .moext is also retained at dist/builtin-moext/<file> so the
// builtin-moext smoke test has a stable fixture path across the Task 11 cutover.
//
// Resolution order per plugin (sha256 verified at EVERY source; a digest
// mismatch at a source is a hard failure, never a fallthrough):
//   1. $MOTRIX_BUILTIN_ARTIFACT_DIR/<file>     (local bootstrap/dev)
//   2. node_modules/.cache/motrix-builtins/<sha256>.moext
//   3. https://github.com/<repo>/releases/download/<tag>/<file>
//
// Every artifact must ALSO carry a valid detached Ed25519 signature
// (`<file>.sig`, resolved with the same source order) verifying against the
// public key pinned at scripts/builtins-signing.pub.pem — a missing or
// invalid signature is a hard failure regardless of source. The pinned key
// is the trust root for builtin updates; the lockfile digest pins content,
// the signature proves it was minted by the plugin-signing release pipeline.
//
// MOTRIX_SKIP_BUILTIN_FETCH=1 skips the network work but still ASSERTS every
// lockfile id already has a seed on disk (a packaging run must never go green
// with empty/stale seeds). Plain Node 20, no TypeScript — mirrors fetch-engine.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yauzl from 'yauzl'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const LOCK_PATH = path.join(SCRIPT_DIR, 'builtins.lock.json')
const PUB_KEY_PATH = path.join(SCRIPT_DIR, 'builtins-signing.pub.pem')
const OUT_DIR = path.join(REPO_ROOT, 'dist', 'builtin-plugins')
const MOEXT_DIR = path.join(REPO_ROOT, 'dist', 'builtin-moext')
const CACHE_DIR = path.join(
  REPO_ROOT,
  'node_modules',
  '.cache',
  'motrix-builtins'
)
const GITHUB = 'https://github.com'
const TIMEOUT_MS = 30_000
const RETRIES = 3
const BACKOFF_MS = 500
// Uncompressed-size caps, same shape as pack.mjs (Task 3): a plugin bundle is
// ≤ 1 MiB and the whole extracted tree ≤ 5 MiB — a decompression-bomb guard.
const ENTRY_MAX = 1 << 20
const TOTAL_MAX = 5 << 20
// A .sig sidecar is ~88 chars of base64 (64-byte Ed25519 signature); anything
// near this cap is already garbage.
const SIG_MAX = 1024
const ID_RE = /^motrix\.[a-z0-9][a-z0-9-]*$/

export const EXIT_OK = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function verifyDigest(bytes, expected) {
  return sha256Hex(bytes) === String(expected).toLowerCase()
}

// Validate the lockfile — the trust root for seeds. Every field that feeds a
// filesystem path is constrained so a malicious lockfile diff cannot become a
// traversal/rm primitive over the repo (the id key flows into rm+rename on
// OUT_DIR; entry.file flows into write paths).
export function parseLock(text) {
  const lock = JSON.parse(text)
  if (typeof lock.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(lock.repo)) {
    throw new Error('lockfile: missing or malformed repo')
  }
  const entries = Object.entries(lock.plugins ?? {})
  if (entries.length === 0) throw new Error('lockfile: plugins map is empty')
  for (const [id, e] of entries) {
    if (!ID_RE.test(id)) throw new Error(`lockfile: illegal plugin id "${id}"`)
    for (const key of ['tag', 'version', 'file', 'sha256']) {
      if (typeof e[key] !== 'string' || e[key] === '') {
        throw new Error(`lockfile: ${id} missing ${key}`)
      }
    }
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) {
      throw new Error(`lockfile: ${id} sha256 malformed`)
    }
    // Reject backslashes in every field that flows into a filesystem path or
    // a release URL. path.basename() only splits on '/' on POSIX, so a
    // Windows-style '..\..\x' segment would otherwise slip past the
    // canonical-name check below; releaseUrl() also interpolates these
    // fields, and WHATWG URL treats '\' as '/'.
    for (const key of ['tag', 'version', 'file']) {
      if (e[key].includes('\\')) {
        throw new Error(`lockfile: ${id} ${key} contains a backslash`)
      }
    }
    // file must be a bare basename AND exactly the canonical <id>-<version>.moext
    if (
      e.file !== path.basename(e.file) ||
      e.file !== `${id}-${e.version}.moext`
    ) {
      throw new Error(`lockfile: ${id} file "${e.file}" not the canonical name`)
    }
    // Upper-bound the declared size to the same TOTAL_MAX pack.mjs enforces
    // on the producing side — otherwise a malicious/corrupt lockfile could
    // declare an arbitrarily large size and defeat downloadBytes' size cap
    // (the cap is only as tight as the number we trust it with).
    if (!Number.isInteger(e.size) || e.size <= 0 || e.size > TOTAL_MAX) {
      throw new Error(
        `lockfile: ${id} size must be a positive integer <= ${TOTAL_MAX}`
      )
    }
  }
  return lock
}

export function releaseUrl(repo, entry) {
  return `${GITHUB}/${repo}/releases/download/${encodeURIComponent(entry.tag)}/${encodeURIComponent(entry.file)}`
}

// Detached Ed25519 signature check over the artifact bytes. `sigText` is the
// base64 sidecar content produced by the builtin-plugins release pipeline's
// sign job. Any decode/verify error is a plain `false` — callers hard-fail.
export function verifySignature(bytes, sigText, pubPem) {
  const sig = Buffer.from(String(sigText).trim(), 'base64')
  if (sig.length === 0) return false
  try {
    return verify(null, bytes, createPublicKey(pubPem), sig)
  } catch {
    return false
  }
}

// Resolve the `.sig` sidecar for one lock entry, mirroring resolveArtifact's
// source order (local artifact dir → cache → release URL). Returns the raw
// sidecar text; validation against the artifact bytes happens in installOne,
// so a stale/tampered sidecar from ANY source fails the install rather than
// falling through.
export async function resolveSignature(entry, repo, deps, artifactDir) {
  if (artifactDir) {
    const local = await deps.readLocal(
      path.join(artifactDir, `${entry.file}.sig`)
    )
    if (local) return local.toString('utf8')
  }
  const cached = await deps.readCacheSig(entry.sha256)
  if (cached) return cached.toString('utf8')
  const bytes = await deps.download(`${releaseUrl(repo, entry)}.sig`, SIG_MAX)
  return bytes.toString('utf8')
}

// Resolve artifact bytes for one lock entry. `deps` injects IO for tests.
export async function resolveArtifact(entry, repo, deps, artifactDir) {
  if (artifactDir) {
    const local = await deps.readLocal(path.join(artifactDir, entry.file))
    if (local) {
      if (!verifyDigest(local, entry.sha256)) {
        throw new Error(
          `${entry.file}: local artifact digest mismatch (expected ${entry.sha256}, got ${sha256Hex(local)})`
        )
      }
      return local
    }
  }
  const cached = await deps.readCache(entry.sha256)
  if (cached) {
    if (!verifyDigest(cached, entry.sha256)) {
      throw new Error(
        `${entry.file}: cached artifact digest mismatch (expected ${entry.sha256}, got ${sha256Hex(cached)})`
      )
    }
    return cached
  }
  const bytes = await deps.download(releaseUrl(repo, entry), entry.size)
  if (!verifyDigest(bytes, entry.sha256)) {
    throw new Error(
      `${entry.file}: download digest mismatch (expected ${entry.sha256}, got ${sha256Hex(bytes)})`
    )
  }
  await deps.writeCache(entry.sha256, bytes)
  return bytes
}

// Extract a verified in-memory .moext into destDir. Guards ported from
// src/core/plugin/install/moext-reader.ts: reject absolute paths, '..'
// segments, backslashes, and symlink entries; enforce path containment via
// resolve+relative; cap per-entry and total uncompressed bytes. Operating on
// the already-verified buffer (yauzl.fromBuffer) removes the temp-zip TOCTOU.
export function extractMoext(bytes, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err)
      let total = 0
      let settled = false
      const finish = (fn, arg) => {
        if (settled) return
        settled = true
        zip.close()
        fn(arg)
      }
      zip.on('entry', (entry) => {
        const rel = entry.fileName
        if (rel.endsWith('/')) return zip.readEntry() // skip dir records
        if (
          rel.includes('\\') ||
          rel.split('/').includes('..') ||
          path.isAbsolute(rel)
        ) {
          return finish(reject, new Error(`illegal zip entry: ${rel}`))
        }
        // Unix external attrs high 16 bits carry the mode; S_IFLNK == 0xA000.
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff
        if ((mode & 0xf000) === 0xa000) {
          return finish(reject, new Error(`symlink zip entry rejected: ${rel}`))
        }
        const abs = path.resolve(destDir, rel)
        const relToDest = path.relative(destDir, abs)
        if (relToDest.startsWith('..') || path.isAbsolute(relToDest)) {
          return finish(reject, new Error(`zip entry escapes dest: ${rel}`))
        }
        if (entry.uncompressedSize > ENTRY_MAX) {
          return finish(reject, new Error(`zip entry ${rel} exceeds cap`))
        }
        total += entry.uncompressedSize
        if (total > TOTAL_MAX) {
          return finish(reject, new Error('zip total exceeds cap'))
        }
        zip.openReadStream(entry, (rsErr, rs) => {
          if (rsErr) return finish(reject, rsErr)
          const chunks = []
          rs.on('data', (c) => chunks.push(c))
          rs.on('error', (e) => finish(reject, e))
          rs.on('end', () => {
            mkdir(path.dirname(abs), { recursive: true })
              .then(() => writeFile(abs, Buffer.concat(chunks)))
              .then(() => zip.readEntry())
              .catch((e) => finish(reject, e))
          })
        })
      })
      zip.on('end', () => finish(resolve, undefined))
      zip.on('error', (e) => finish(reject, e))
      zip.readEntry()
    })
  })
}

// Fetch + verify + unpack one plugin into dist/builtin-plugins/<id>/, staging
// inside OUT_DIR so the final rename is same-filesystem (os.tmpdir() may be a
// different volume — EXDEV; see scripts/fetch-engine.mjs). Also mirrors the
// verified .moext into dist/builtin-moext/<file>.
export async function installOne(id, entry, repo, deps, artifactDir, pubPem) {
  const bytes = await resolveArtifact(entry, repo, deps, artifactDir)
  const sigText = await resolveSignature(entry, repo, deps, artifactDir)
  if (!verifySignature(bytes, sigText, pubPem)) {
    throw new Error(
      `${entry.file}: Ed25519 signature verification failed against ${path.basename(PUB_KEY_PATH)}`
    )
  }
  await deps.writeCacheSig(entry.sha256, sigText)
  await mkdir(OUT_DIR, { recursive: true })
  const stageDir = path.join(
    OUT_DIR,
    `.staging-${id}-${randomBytes(6).toString('hex')}`
  )
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })
  try {
    await extractMoext(bytes, stageDir)
    const manifest = JSON.parse(
      await readFile(path.join(stageDir, 'motrix-plugin.json'), 'utf8')
    )
    if (manifest.id !== id) {
      throw new Error(`${id}: manifest.id "${manifest.id}" != lock key`)
    }
    if (manifest.version !== entry.version) {
      throw new Error(
        `${id}: manifest version ${manifest.version} != lock ${entry.version}`
      )
    }
    const dest = path.join(OUT_DIR, id)
    await rm(dest, { recursive: true, force: true })
    await rename(stageDir, dest)
    await mkdir(MOEXT_DIR, { recursive: true })
    await writeFile(path.join(MOEXT_DIR, entry.file), bytes)
  } finally {
    await rm(stageDir, { recursive: true, force: true })
  }
}

// Stream the response body with a running byte counter instead of buffering
// the whole thing before checking its size: `Buffer.from(await
// res.arrayBuffer())` would materialize an attacker/corruption-controlled
// body in full (the size cap only kicked in *after* the OOM already
// happened). Bail out — without reading further — the moment either the
// declared Content-Length or the running total exceeds sizeCap.
export async function downloadBytes(url, sizeCap) {
  let lastErr
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
      if (sizeCap) {
        const declared = Number(res.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > sizeCap) {
          throw Object.assign(
            new Error(
              `${url}: Content-Length ${declared}B exceeds lock size ${sizeCap}B`
            ),
            { fatal: true }
          )
        }
      }
      if (!res.body) {
        // No streamable body (unlikely for a real GET) — fall back to the
        // whole-buffer path, still checked against sizeCap before returning.
        const bytes = Buffer.from(await res.arrayBuffer())
        if (sizeCap && bytes.length > sizeCap) {
          throw Object.assign(
            new Error(
              `${url}: body ${bytes.length}B exceeds lock size ${sizeCap}B`
            ),
            { fatal: true }
          )
        }
        return bytes
      }
      const reader = res.body.getReader()
      const chunks = []
      let total = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.length
          if (sizeCap && total > sizeCap) {
            // Not retryable — a genuine over-cap body is an attack/corruption,
            // not a transient failure. Cancel the stream so the rest of the
            // (potentially huge) body is never read off the wire.
            throw Object.assign(
              new Error(
                `${url}: body exceeds lock size ${sizeCap}B (aborted at ${total}B)`
              ),
              { fatal: true }
            )
          }
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      return Buffer.concat(chunks.map((c) => Buffer.from(c)))
    } catch (err) {
      if (err?.fatal) throw err
      lastErr = err
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt))
      }
    }
  }
  throw lastErr
}

const realDeps = {
  readLocal: async (p) => {
    try {
      return await readFile(p)
    } catch {
      return null
    }
  },
  readCache: async (sha) => {
    try {
      return await readFile(path.join(CACHE_DIR, `${sha}.moext`))
    } catch {
      return null
    }
  },
  writeCache: async (sha, bytes) => {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(path.join(CACHE_DIR, `${sha}.moext`), bytes)
  },
  readCacheSig: async (sha) => {
    try {
      return await readFile(path.join(CACHE_DIR, `${sha}.moext.sig`))
    } catch {
      return null
    }
  },
  writeCacheSig: async (sha, sigText) => {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(path.join(CACHE_DIR, `${sha}.moext.sig`), sigText)
  },
  download: downloadBytes,
}

// Delete any dist/builtin-plugins/<id> not named by the lockfile (a removed
// builtin must not linger as a stale seed). Also sweeps any leftover
// `.staging-*` dir: prune runs only after the sequential installOne loop
// (no concurrency), so any staging dir still present here is necessarily an
// orphan from a prior crashed run, not one currently in flight.
async function pruneOutDir(lockIds) {
  let names
  try {
    names = await readdir(OUT_DIR)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith('.staging-') || !lockIds.has(name)) {
      await rm(path.join(OUT_DIR, name), { recursive: true, force: true })
    }
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    const lock = parseLock(await readFile(LOCK_PATH, 'utf8'))
    const lockIds = new Set(Object.keys(lock.plugins))
    if (process.env.MOTRIX_SKIP_BUILTIN_FETCH === '1') {
      // Skip network, but every lock id MUST already have a seed on disk.
      const missing = []
      for (const id of lockIds) {
        try {
          await readFile(path.join(OUT_DIR, id, 'motrix-plugin.json'))
        } catch {
          missing.push(id)
        }
      }
      if (missing.length) {
        console.error(
          `[fetch-builtins] SKIP set but seeds missing: ${missing.join(', ')}`
        )
        process.exit(EXIT_FAILURE)
      }
      console.log('[fetch-builtins] skipped (seeds present)')
      process.exit(EXIT_OK)
    }
    let pubPem
    try {
      pubPem = await readFile(PUB_KEY_PATH, 'utf8')
    } catch {
      console.error(
        `[fetch-builtins] missing signing public key at ${PUB_KEY_PATH} — cannot verify releases`
      )
      process.exit(EXIT_FAILURE)
    }
    const artifactDir = process.env.MOTRIX_BUILTIN_ARTIFACT_DIR || undefined
    for (const [id, entry] of Object.entries(lock.plugins)) {
      await installOne(id, entry, lock.repo, realDeps, artifactDir, pubPem)
      console.log(`[fetch-builtins] ${id}@${entry.version} ok (sig verified)`)
    }
    await pruneOutDir(lockIds)
    process.exit(EXIT_OK)
  } catch (err) {
    console.error(`[fetch-builtins] ${err?.message ?? err}`)
    console.error(
      '[fetch-builtins] offline? set MOTRIX_BUILTIN_ARTIFACT_DIR=<dir of .moext + .moext.sig> (or MOTRIX_SKIP_BUILTIN_FETCH=1 only if seeds already exist)'
    )
    process.exit(EXIT_FAILURE)
  }
}
