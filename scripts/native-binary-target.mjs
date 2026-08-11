import { readFile } from 'node:fs/promises'

const MACH_CPU_ARCHES = new Map([
  [0x01000007, 'x64'],
  [0x0100000c, 'arm64'],
])
const ELF_MACHINE_ARCHES = new Map([
  [62, 'x64'],
  [183, 'arm64'],
])
const PE_MACHINE_ARCHES = new Map([
  [0x8664, 'x64'],
  [0xaa64, 'arm64'],
])
const PLATFORM_FORMATS = {
  darwin: 'mach-o',
  linux: 'elf',
  win32: 'pe',
}

function readUInt32(bytes, offset, littleEndian) {
  return littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
}

function uniqueSorted(values) {
  return [...new Set(values)].sort()
}

function detectMach(bytes) {
  if (bytes.length < 8) return undefined
  const magic = bytes.subarray(0, 4).toString('hex')
  const thin =
    magic === 'cffaedfe'
      ? { littleEndian: true }
      : magic === 'feedfacf'
        ? { littleEndian: false }
        : undefined
  if (thin) {
    const arch = MACH_CPU_ARCHES.get(readUInt32(bytes, 4, thin.littleEndian))
    return arch ? { format: 'mach-o', arches: [arch] } : undefined
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
            : undefined
  if (!fat) return undefined
  const count = readUInt32(bytes, 4, fat.littleEndian)
  if (count === 0 || count > 64 || bytes.length < 8 + count * fat.entrySize) {
    return undefined
  }
  const arches = []
  for (let index = 0; index < count; index += 1) {
    const arch = MACH_CPU_ARCHES.get(
      readUInt32(bytes, 8 + index * fat.entrySize, fat.littleEndian)
    )
    if (arch) arches.push(arch)
  }
  return arches.length > 0
    ? { format: 'mach-o', arches: uniqueSorted(arches) }
    : undefined
}

function detectElf(bytes) {
  if (
    bytes.length < 20 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2
  ) {
    return undefined
  }
  const machine =
    bytes[5] === 1
      ? bytes.readUInt16LE(18)
      : bytes[5] === 2
        ? bytes.readUInt16BE(18)
        : undefined
  const arch = ELF_MACHINE_ARCHES.get(machine)
  return arch ? { format: 'elf', arches: [arch] } : undefined
}

function detectPe(bytes) {
  if (bytes.length < 64 || !bytes.subarray(0, 2).equals(Buffer.from('MZ'))) {
    return undefined
  }
  const offset = bytes.readUInt32LE(0x3c)
  if (
    offset > bytes.length - 6 ||
    !bytes.subarray(offset, offset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))
  ) {
    return undefined
  }
  const arch = PE_MACHINE_ARCHES.get(bytes.readUInt16LE(offset + 4))
  return arch ? { format: 'pe', arches: [arch] } : undefined
}

export function detectNativeBinaryTarget(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error('native binary input must be a Buffer')
  }
  return detectMach(bytes) ?? detectElf(bytes) ?? detectPe(bytes)
}

export async function readNativeBinaryTarget(filePath) {
  return detectNativeBinaryTarget(await readFile(filePath))
}

export async function assertNativeBinaryTarget(
  filePath,
  platform,
  arch,
  options = {}
) {
  const expectedFormat = PLATFORM_FORMATS[platform]
  if (!expectedFormat || !['arm64', 'x64'].includes(arch)) {
    throw new Error(`unsupported native binary target ${platform}-${arch}`)
  }
  const detected = await readNativeBinaryTarget(filePath)
  const label = options.label ?? 'native binary'
  if (
    !detected ||
    detected.format !== expectedFormat ||
    !detected.arches.includes(arch)
  ) {
    throw new Error(
      `${label} has an invalid header; expected ${platform}-${arch}`
    )
  }
  if (
    detected.format === 'mach-o' &&
    detected.arches.length > 1 &&
    options.allowUniversal !== true
  ) {
    throw new Error(
      `${label} is universal Mach-O; universal Mach-O is not allowed`
    )
  }
  return detected
}
