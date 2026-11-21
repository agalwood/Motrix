#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  ENGINE_DIGEST_ALGORITHM,
  nativeEngineDigest,
} from './native-engine-digest.mjs'

export {
  binaryName,
  bundledPath,
  readEngineSource,
  sha256Hex,
} from './engine-source.mjs'

import { projectRoot, readEngineSource, sha256Hex } from './engine-source.mjs'

const BUILD_CACHE_LAYOUT = 'source-digest-v1'

function execute(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options })
}

export async function prepareSource({ source }, suppliedSource, root) {
  const cache = path.join(root, 'output/taiji-source', source.revision)
  const marker = path.join(cache, '.motrix-source-ready')
  let ready = false
  try {
    ready = (await readFile(marker, 'utf8')) === source.cargoLockSha256
  } catch {}
  if (!ready) {
    // This directory is owned by this pinned build, not the caller's checkout.
    await rm(cache, { recursive: true, force: true })
    await mkdir(cache, { recursive: true })
    execute('git', ['init', '--quiet', cache])
    execute('git', ['-C', cache, 'config', 'core.autocrlf', 'false'])
    execute('git', ['-C', cache, 'config', 'core.eol', 'lf'])
    execute(
      'git',
      [
        '-C',
        cache,
        'fetch',
        '--quiet',
        '--depth=1',
        suppliedSource ? path.resolve(suppliedSource) : source.repository,
        source.revision,
      ],
      { stdio: 'inherit' }
    )
    execute('git', [
      '-C',
      cache,
      'checkout',
      '--quiet',
      '--detach',
      'FETCH_HEAD',
    ])
    if (
      execute('git', ['-C', cache, 'rev-parse', 'HEAD']).trim() !==
      source.revision
    )
      throw new Error('taiji source revision mismatch')
    if (
      sha256Hex(await readFile(path.join(cache, 'Cargo.lock'))) !==
      source.cargoLockSha256
    )
      throw new Error('taiji Cargo.lock digest mismatch')
    await writeFile(marker, source.cargoLockSha256)
  }
  execute('git', ['-C', cache, 'diff', '--quiet', 'HEAD'])
  if (
    execute('git', ['-C', cache, 'rev-parse', 'HEAD']).trim() !==
      source.revision ||
    sha256Hex(await readFile(path.join(cache, 'Cargo.lock'))) !==
      source.cargoLockSha256
  )
    throw new Error(
      'Cached taiji source differs from the pinned upstream commit'
    )
  const untracked = execute('git', [
    '-C',
    cache,
    'ls-files',
    '--others',
    '--exclude-standard',
  ])
    .trim()
    .split('\n')
    .filter(Boolean)
  if (untracked.some((name) => name !== '.motrix-source-ready'))
    throw new Error('Unexpected files in the cached taiji source')
  return cache
}

export async function prepareOfflineSource(info, directory, root) {
  const expected = path.join(root, 'taiji-source')
  if (
    process.env.MOTRIX_FLATPAK_BUILD !== '1' ||
    path.resolve(directory) !== expected
  )
    throw new Error(
      'Prepared engine sources are restricted to the offline Flatpak build'
    )
  if (
    (await realpath(expected)) !==
    path.join(await realpath(root), 'taiji-source')
  )
    throw new Error(
      'Prepared engine source must not escape the Flatpak build directory'
    )
  const lockPath = path.join(expected, 'Cargo.lock')
  const digest = sha256Hex(await readFile(lockPath))
  if (digest !== info.source.cargoLockSha256)
    throw new Error(
      'Flatpak taiji source does not match the locked Cargo graph'
    )
  return expected
}

async function licenseBundle(sourceDir, target) {
  const metadata = JSON.parse(
    execute(
      'cargo',
      [
        'metadata',
        '--manifest-path',
        path.join(sourceDir, 'Cargo.toml'),
        '--locked',
        '--format-version=1',
        '--filter-platform',
        target,
      ],
      { maxBuffer: 32 * 1024 * 1024 }
    )
  )
  const sections = []
  for (const pkg of metadata.packages.sort((a, b) =>
    a.id.localeCompare(b.id)
  )) {
    if (!pkg.source) continue
    const directory = path.dirname(pkg.manifest_path)
    const names = (await readdir(directory)).filter((name) =>
      /^(?:license|licence|copying|notice|copyright)(?:[._-].*)?$/i.test(name)
    )
    if (pkg.license_file && !names.includes(pkg.license_file))
      names.push(pkg.license_file)
    sections.push(
      `## ${pkg.name} ${pkg.version}\nLicense: ${pkg.license ?? 'see license file'}\nSource: ${pkg.repository ?? pkg.source}\n`
    )
    const canonicalDirectory = await realpath(directory)
    for (const name of names.sort()) {
      const file = await realpath(path.resolve(directory, name))
      const relative = path.relative(canonicalDirectory, file)
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error('Dependency license escapes its package directory')
      const info = await stat(file)
      if (info.isDirectory()) continue
      if (!info.isFile() || info.size > 2 * 1024 * 1024)
        throw new Error('Invalid dependency license file')
      sections.push(`${relative}\n${await readFile(file, 'utf8')}\n`)
    }
  }
  const supplementRoot = path.join(sourceDir, 'packaging/licenses')
  const supplements = JSON.parse(
    await readFile(path.join(supplementRoot, 'supplements.json'), 'utf8')
  )
  for (const pkg of metadata.packages) {
    const entries = supplements[`${pkg.name}@${pkg.version}`]
    if (!entries) continue
    sections.push(
      `## Upstream license supplement: ${pkg.name} ${pkg.version}\n`
    )
    for (const entry of entries) {
      sections.push(`Source: ${entry.source}\n`)
      if (entry.upstreamMissingText) {
        sections.push(
          `${entry.note}\nPackage authors: ${pkg.authors.join(', ')}\n`
        )
      } else {
        if (
          typeof entry.file !== 'string' ||
          path.basename(entry.file) !== entry.file
        )
          throw new Error('Invalid upstream license supplement')
        const file = await realpath(path.join(supplementRoot, entry.file))
        if (path.dirname(file) !== (await realpath(supplementRoot)))
          throw new Error(
            'Upstream license supplement escapes its source directory'
          )
        const info = await stat(file)
        if (!info.isFile() || info.size > 2 * 1024 * 1024)
          throw new Error('Invalid upstream license supplement file')
        sections.push(`${entry.file}\n${await readFile(file, 'utf8')}\n`)
      }
    }
  }
  return sections.join('\n')
}

export function taijiBuildEnvironment(rustTarget, environment = process.env) {
  const result = { ...environment }
  if (rustTarget.endsWith('-windows-msvc')) {
    // A standalone sidecar must not require an external VC++ redistributable.
    // Cargo gives encoded flags precedence over ordinary RUSTFLAGS.
    if (result.CARGO_ENCODED_RUSTFLAGS !== undefined) {
      result.CARGO_ENCODED_RUSTFLAGS = [
        result.CARGO_ENCODED_RUSTFLAGS,
        '-C',
        'target-feature=+crt-static',
        '-C',
        'link-arg=/STACK:8388608',
      ]
        .filter(Boolean)
        .join('\x1f')
    } else {
      result.RUSTFLAGS =
        `${result.RUSTFLAGS ?? ''} -C target-feature=+crt-static -C link-arg=/STACK:8388608`.trim()
    }
  }
  return result
}

export async function buildTaiji(options = {}) {
  const root = options.root ?? projectRoot
  const info = await readEngineSource(root)
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const asset = info.lock.assets[`${platform}-${arch}`]
  if (!asset) throw new Error(`Unsupported taiji target: ${platform}-${arch}`)
  const distribution =
    options.distribution ??
    (process.env.MOTRIX_FLATPAK_BUILD === '1' ? 'flatpak' : 'desktop')
  if (!['desktop', 'flatpak'].includes(distribution))
    throw new Error('Unsupported engine distribution')
  const rustTarget =
    distribution === 'flatpak' ? asset.flatpakRustTarget : asset.rustTarget
  if (!rustTarget) throw new Error('Unsupported taiji distribution target')
  const destination = path.join(root, 'extra', platform, arch)
  const binary = path.join(destination, asset.bin)
  const receiptPath = path.join(destination, 'taiji-build.json')
  const profile = options.debug ? 'debug' : 'release'
  if (!options.force && !options.test) {
    try {
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
      if (
        receipt.version === info.lock.version &&
        receipt.sourceDigest === info.sourceDigest &&
        receipt.buildCacheLayout === BUILD_CACHE_LAYOUT &&
        receipt.profile === profile &&
        receipt.digestAlgorithm === ENGINE_DIGEST_ALGORITHM &&
        /^[a-f0-9]{64}$/.test(receipt.nativePayloadSha256 ?? '') &&
        receipt.target === rustTarget &&
        receipt.binarySha256 === sha256Hex(await readFile(binary)) &&
        receipt.licenseSha256 ===
          sha256Hex(
            await readFile(path.join(destination, 'taiji-licenses.txt'))
          )
      )
        return binary
    } catch {}
  }
  const sourceDir =
    distribution === 'flatpak'
      ? await prepareOfflineSource(
          info,
          options.preparedSource ?? path.join(root, 'taiji-source'),
          root
        )
      : await prepareSource(
          info,
          options.source ?? process.env.MOTRIX_TAIJI_SOURCE,
          root
        )
  // Distinct source pins can share a SemVer and binary name. Keep their Cargo
  // artifacts separate so a cached build cannot copy another checkout's binary.
  const targetDir = path.join(root, 'output/taiji-build', info.sourceDigest)
  const buildEnv = taijiBuildEnvironment(rustTarget)
  if (process.platform === 'linux' && rustTarget.includes('musl')) {
    const host = execute('rustc', ['-vV']).match(/^host: (\S+)$/m)?.[1]
    const compilerKey = `CC_${rustTarget.replaceAll('-', '_')}`
    if (!host?.includes('musl') && !buildEnv[compilerKey]) {
      try {
        execute('musl-gcc', ['--version'])
      } catch {
        throw new Error(
          'Install musl-tools to compile the taiji C dependencies for Linux'
        )
      }
      // Only C object compilation uses musl-gcc. Rust keeps its self-contained CRT/linker.
      buildEnv[compilerKey] = 'musl-gcc'
    }
  }
  if (options.test) {
    for (const selection of [
      [
        '-p',
        'taiji-core',
        '-p',
        'taiji-domain',
        '-p',
        'taiji-engine',
        '-p',
        'taiji-bt',
        '-p',
        'taiji-store',
        '-p',
        'taiji-io',
        '-p',
        'taiji-http',
        '--lib',
      ],
      [
        '-p',
        'taiji-core',
        '--test',
        'magnet_chain',
        '--test',
        'dns_discovery',
        '--test',
        'dual_swarm',
      ],
      [
        '-p',
        'taiji-io',
        '--test',
        'dns_concurrency',
        '--test',
        'dns_network_change',
      ],
      ['-p', 'taiji', '--test', 'import_flow'],
      ['-p', 'taiji-rpc', '--test', 'rpc_boundary_guard'],
    ]) {
      const tested = spawnSync(
        'cargo',
        [
          'test',
          '--no-fail-fast',
          '--locked',
          '--manifest-path',
          path.join(sourceDir, 'Cargo.toml'),
          '--target-dir',
          targetDir,
          '--target',
          rustTarget,
          ...selection,
        ],
        { stdio: 'inherit', env: buildEnv }
      )
      if (tested.error) throw tested.error
      if (tested.status !== 0)
        throw new Error(
          `taiji native tests failed (${tested.signal ?? tested.status})`
        )
    }
  }
  const result = spawnSync(
    'cargo',
    [
      'build',
      '--locked',
      '--manifest-path',
      path.join(sourceDir, 'Cargo.toml'),
      '--target-dir',
      targetDir,
      '--target',
      rustTarget,
      '-p',
      'taiji',
      ...(options.debug ? [] : ['--release']),
    ],
    { stdio: 'inherit', env: buildEnv }
  )
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`taiji build failed (${result.signal ?? result.status})`)
  const built = path.join(targetDir, rustTarget, profile, asset.bin)
  if (platform === process.platform && arch === process.arch) {
    const version = execute(built, ['--version'], { timeout: 10000 }).trim()
    if (version !== `taiji taiji/${info.lock.version}`)
      throw new Error('Built taiji version does not match the engine lock')
  }
  const licenses = await licenseBundle(sourceDir, rustTarget)
  await mkdir(destination, { recursive: true })
  const staged = `${binary}.${process.pid}.tmp`
  try {
    await copyFile(built, staged)
    await chmod(staged, 0o755)
    await rename(staged, binary)
  } finally {
    await rm(staged, { force: true })
  }
  await writeFile(path.join(destination, 'taiji-licenses.txt'), licenses)
  await writeFile(
    receiptPath,
    `${JSON.stringify(
      {
        version: info.lock.version,
        sourceDigest: info.sourceDigest,
        buildCacheLayout: BUILD_CACHE_LAYOUT,
        revision: info.source.revision,
        cargoLockSha256: info.source.cargoLockSha256,
        profile,
        target: rustTarget,
        binarySha256: sha256Hex(await readFile(binary)),
        digestAlgorithm: ENGINE_DIGEST_ALGORITHM,
        nativePayloadSha256: await nativeEngineDigest(binary, platform),
        licenseSha256: sha256Hex(licenses),
      },
      null,
      2
    )}\n`
  )
  console.log(`Built taiji ${info.lock.version}: ${binary}`)
  return binary
}

export async function runBuild(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      source: { type: 'string' },
      'prepared-source': { type: 'string' },
      distribution: { type: 'string' },
      debug: { type: 'boolean', default: false },
      test: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      platform: { type: 'string' },
      arch: { type: 'string' },
    },
  })
  return buildTaiji({ ...values, preparedSource: values['prepared-source'] })
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runBuild().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
