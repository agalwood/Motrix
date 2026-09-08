import { execFile } from 'node:child_process'
import { lstat, mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseStrictSemVer } from './release-metadata.mjs'
import { verifyElectronPackage } from './verify-electron-package.mjs'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARCH_NAMES = { x64: 'x86_64', arm64: 'aarch64' }

export function expectedPacmanName(version, arch) {
  parseStrictSemVer(version, 'release version')
  if (!Object.hasOwn(ARCH_NAMES, arch)) {
    throw new Error(`Unsupported pacman architecture: ${arch}`)
  }
  return `Motrix-${version}-${arch === 'arm64' ? 'aarch64' : 'x64'}.pacman`
}

export function assertPacmanMetadata(source, { version, arch, depends }) {
  expectedPacmanName(version, arch)
  const fields = new Map()
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    const match = /^([a-z]+) = (.+)$/.exec(line)
    if (!match) throw new Error(`Invalid .PKGINFO line: ${line}`)
    const [, key, value] = match
    fields.set(key, [...(fields.get(key) ?? []), value])
  }
  for (const [key, expected] of Object.entries({
    pkgname: 'motrix',
    pkgver: `${version.replaceAll('-', '_')}-1`,
    arch: ARCH_NAMES[arch],
    url: 'https://motrix.app',
    license: 'MIT',
  })) {
    const values = fields.get(key)
    if (values?.length !== 1 || values[0] !== expected) {
      throw new Error(`.PKGINFO ${key} must be ${expected}`)
    }
  }
  const actualDepends = new Set(fields.get('depend') ?? [])
  for (const dependency of depends) {
    if (!actualDepends.has(dependency)) {
      throw new Error(`.PKGINFO missing dependency: ${dependency}`)
    }
  }
  for (const conflict of ['motrix-bin', 'motrix-git', 'motrix-beta-bin']) {
    if (!fields.get('conflict')?.includes(conflict)) {
      throw new Error(`.PKGINFO missing conflict: ${conflict}`)
    }
  }
}

export async function verifyPacmanArtifact({
  directory,
  version,
  arch,
  verifyPayload = verifyElectronPackage,
  extractArchive = (artifact, destination) =>
    execFileAsync('bsdtar', ['-xf', artifact, '-C', destination]),
}) {
  const expected = expectedPacmanName(version, arch)
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith('.pacman')
  )
  if (files.length !== 1 || files[0] !== expected) {
    throw new Error(`Expected exactly one pacman artifact named ${expected}`)
  }
  const artifact = path.resolve(directory, expected)
  if (!(await lstat(artifact)).isFile()) {
    throw new Error('Pacman artifact must be a regular file')
  }
  const handle = await open(artifact, 'r')
  try {
    const magic = Buffer.alloc(4)
    await handle.read(magic, 0, magic.length, 0)
    if (magic.toString('hex') !== '28b52ffd') {
      throw new Error('Pacman artifact must use Zstandard compression')
    }
  } finally {
    await handle.close()
  }

  // Inspect the final archive, including native binaries and ASAR contents,
  // rather than assuming the unpacked electron-builder input was preserved.
  const temporary = await mkdtemp(path.join(tmpdir(), 'motrix-pacman-'))
  try {
    await extractArchive(artifact, temporary)
    const config = JSON.parse(
      await readFile(path.join(ROOT, 'electron-builder.json'), 'utf8')
    )
    assertPacmanMetadata(
      await readFile(path.join(temporary, '.PKGINFO'), 'utf8'),
      { version, arch, depends: config.pacman.depends }
    )
    if (!(await lstat(path.join(temporary, '.MTREE'))).isFile()) {
      throw new Error('Pacman artifact is missing .MTREE')
    }
    const appDir = path.join(temporary, 'opt/Motrix')
    const packageType = await readFile(
      path.join(appDir, 'resources/package-type'),
      'utf8'
    )
    if (packageType.trim() !== 'pacman') {
      throw new Error('Pacman package must select the pacman updater')
    }
    const desktop = await readFile(
      path.join(temporary, 'usr/share/applications/motrix.desktop'),
      'utf8'
    )
    const mime = /^MimeType=(.*)$/m.exec(desktop)?.[1].split(';') ?? []
    for (const type of [
      'application/x-bittorrent',
      'x-scheme-handler/magnet',
      'x-scheme-handler/motrix',
    ]) {
      if (!mime.includes(type)) {
        throw new Error(`Pacman desktop entry is missing ${type}`)
      }
    }
    if (!/^Exec="?\/opt\/Motrix\/motrix"? .*%U.*$/m.test(desktop)) {
      throw new Error(
        'Pacman desktop entry must launch Motrix with URL arguments'
      )
    }
    const binary = await lstat(path.join(appDir, 'motrix'))
    if (!binary.isFile() || (binary.mode & 0o111) === 0) {
      throw new Error('Packaged Motrix must be executable')
    }
    const report = await verifyPayload({
      appDir,
      platform: 'linux',
      arch,
      reportPath: path.resolve(
        directory,
        'size-reports',
        `pacman-${arch}.json`
      ),
    })
    if (!report.passed) {
      throw new Error(
        `Pacman payload verification failed: ${report.errors.join('; ')}`
      )
    }
    return { artifact: expected, arch, version }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { parseArgs } = await import('node:util')
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      version: { type: 'string' },
      arch: { type: 'string' },
    },
  })
  verifyPacmanArtifact({ directory: values.dir ?? 'release', ...values })
    .then((result) =>
      console.log(`[verify-pacman-artifact] passed ${result.artifact}`)
    )
    .catch((error) => {
      console.error(`[verify-pacman-artifact] ${error.message}`)
      process.exitCode = 1
    })
}
