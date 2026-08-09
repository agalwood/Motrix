// electron-builder beforePack hook: fail fast when a target's bundled assets
// are missing, instead of shipping an engine-less app or dying mid-copy.
// Guards two concrete per-arch executables:
//   extra/<platform>/<arch>/aria2c[.exe]        — the download engine
//   packages/native-host/dist/<platform>-<arch>/
//     motrix-native-host[.exe]                  — the browser-bridge host
import { constants } from 'node:fs'
import { access, open, stat } from 'node:fs/promises'
import path from 'node:path'

// electron-builder Arch enum ordinals (builder-util/src/arch.ts).
const ARCH_NAMES = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
}

const TARGET_MACH_CPU = {
  x64: 0x01000007,
  arm64: 0x0100000c,
}

const TARGET_ELF_MACHINE = {
  x64: 62,
  arm64: 183,
}

const TARGET_PE_MACHINE = {
  x64: 0x8664,
  arm64: 0xaa64,
}

async function readExactlyAt(file, length, position) {
  const bytes = Buffer.alloc(length)
  const { bytesRead } = await file.read(bytes, 0, length, position)
  return bytesRead === length ? bytes : null
}

function readUInt32(bytes, offset, littleEndian) {
  return littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
}

async function matchesMachTarget(file, arch) {
  const head = await readExactlyAt(file, 8, 0)
  if (!head) return false

  const magic = head.subarray(0, 4).toString('hex')
  const thin =
    magic === 'cffaedfe'
      ? { littleEndian: true }
      : magic === 'feedfacf'
        ? { littleEndian: false }
        : null
  if (thin) {
    return readUInt32(head, 4, thin.littleEndian) === TARGET_MACH_CPU[arch]
  }

  const fat =
    magic === 'cafebabe'
      ? { littleEndian: false, entrySize: 20 }
      : magic === 'bebafeca'
        ? { littleEndian: true, entrySize: 20 }
        : magic === 'cafebabf'
          ? { littleEndian: false, entrySize: 32 }
          : magic === 'bfbafeca'
            ? { littleEndian: true, entrySize: 32 }
            : null
  if (!fat) return false

  const sliceCount = readUInt32(head, 4, fat.littleEndian)
  if (sliceCount === 0 || sliceCount > 64) return false
  const entries = await readExactlyAt(
    file,
    sliceCount * fat.entrySize,
    head.length
  )
  if (!entries) return false

  for (let index = 0; index < sliceCount; index += 1) {
    const offset = index * fat.entrySize
    if (
      readUInt32(entries, offset, fat.littleEndian) === TARGET_MACH_CPU[arch]
    ) {
      return true
    }
  }
  return false
}

async function matchesElfTarget(file, arch) {
  const head = await readExactlyAt(file, 20, 0)
  if (
    !head?.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    head[4] !== 2
  ) {
    return false
  }
  const machine =
    head[5] === 1
      ? head.readUInt16LE(18)
      : head[5] === 2
        ? head.readUInt16BE(18)
        : null
  return machine === TARGET_ELF_MACHINE[arch]
}

async function matchesPeTarget(file, arch) {
  const dosHead = await readExactlyAt(file, 64, 0)
  if (!dosHead?.subarray(0, 2).equals(Buffer.from('MZ'))) {
    return false
  }
  const peOffset = dosHead.readUInt32LE(0x3c)
  const coffHead = await readExactlyAt(file, 6, peOffset)
  return (
    coffHead?.subarray(0, 4).equals(Buffer.from([0x50, 0x45, 0, 0])) === true &&
    coffHead.readUInt16LE(4) === TARGET_PE_MACHINE[arch]
  )
}

async function matchesExecutableTarget(filePath, platform, arch) {
  const file = await open(filePath, 'r')
  try {
    if (platform === 'darwin') return await matchesMachTarget(file, arch)
    if (platform === 'linux') return await matchesElfTarget(file, arch)
    if (platform === 'win32') return await matchesPeTarget(file, arch)
    return false
  } finally {
    await file.close()
  }
}

async function verifyExecutable(filePath, label, platform, arch) {
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch {
    throw new Error(`[before-pack-verify] missing ${label}: ${filePath}`)
  }

  if (!fileStat.isFile()) {
    throw new Error(
      `[before-pack-verify] ${label} is not a regular file: ${filePath}`
    )
  }

  if (!(await matchesExecutableTarget(filePath, platform, arch))) {
    throw new Error(
      `[before-pack-verify] ${label} is not a ${platform}-${arch} executable: ${filePath}`
    )
  }

  if (platform !== 'win32') {
    try {
      await access(filePath, constants.X_OK)
    } catch {
      throw new Error(
        `[before-pack-verify] ${label} is not executable: ${filePath}`
      )
    }
  }
}

export default async function beforePack(context) {
  const platform = context.electronPlatformName // darwin | win32 | linux
  const archName = ARCH_NAMES[context.arch]
  if (!archName)
    throw new Error(
      `[before-pack-verify] unknown arch ordinal: ${context.arch}`
    )

  const projectDir =
    context.packager.projectDir ?? context.packager.info.projectDir
  const engineBin = platform === 'win32' ? 'aria2c.exe' : 'aria2c'
  const hostBin =
    platform === 'win32' ? 'motrix-native-host.exe' : 'motrix-native-host'
  const arches = archName === 'universal' ? ['x64', 'arm64'] : [archName]

  for (const arch of arches) {
    const engine = path.join(projectDir, 'extra', platform, arch, engineBin)
    await verifyExecutable(engine, 'bundled aria2 engine', platform, arch)

    const host = path.join(
      projectDir,
      'packages',
      'native-host',
      'dist',
      `${platform}-${arch}`,
      hostBin
    )
    await verifyExecutable(host, 'native-host binary', platform, arch)
  }
}
