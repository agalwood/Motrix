import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import beforePack from '../../scripts/before-pack-verify.mjs'

const X64_ARCH_ORDINAL = 1

describe('before-pack-verify', () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'motrix-before-pack-'))
    await writeStage()
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  function context(platform = 'darwin', arch = X64_ARCH_ORDINAL) {
    return {
      electronPlatformName: platform,
      arch,
      packager: { projectDir },
    }
  }

  function enginePath(platform = 'darwin', arch = 'x64') {
    const binaryName = platform === 'win32' ? 'aria2c.exe' : 'aria2c'
    return join(projectDir, 'extra', platform, arch, binaryName)
  }

  function hostPath(platform = 'darwin', arch = 'x64') {
    const binaryName =
      platform === 'win32' ? 'motrix-native-host.exe' : 'motrix-native-host'
    return join(
      projectDir,
      'packages',
      'native-host',
      'dist',
      `${platform}-${arch}`,
      binaryName
    )
  }

  async function writeStage(
    platform = 'darwin',
    arch = 'x64',
    version = '1.2.3'
  ) {
    await writeFile(
      join(projectDir, 'package.json'),
      `${JSON.stringify({ version })}\n`
    )
    const buildOutputs = []
    for (const relativePath of [
      'dist/core/plugin/host/quick-js-worker.cjs',
      'dist/main/index.cjs',
      'dist/preload/preload.cjs',
      'dist/renderer/index.html',
    ]) {
      const target = join(projectDir, relativePath)
      const content = Buffer.from(relativePath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
      buildOutputs.push({
        path: relativePath,
        bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      })
    }
    const manifestPath = join(
      projectDir,
      'dist/electron-app/.motrix-package-stage.json'
    )
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        target: { platform, arch, key: `${platform}-${arch}` },
        rootVersion: version,
        buildOutputs,
      })}\n`
    )
  }

  async function writeBinary(
    filePath: string,
    mode = 0o755,
    platform = 'darwin',
    arch = 'x64'
  ) {
    await mkdir(dirname(filePath), { recursive: true })
    let header: Buffer
    if (platform === 'win32') {
      header = Buffer.alloc(72)
      header.write('MZ')
      header.writeUInt32LE(64, 0x3c)
      header.set([0x50, 0x45, 0, 0], 64)
      header.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 68)
    } else if (platform === 'linux') {
      header = Buffer.alloc(20)
      header.set([0x7f, 0x45, 0x4c, 0x46])
      header[4] = 2
      header[5] = 1
      header.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18)
    } else {
      header = Buffer.alloc(8)
      header.set([0xcf, 0xfa, 0xed, 0xfe])
      header.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
    }
    await writeFile(
      filePath,
      Buffer.concat([header, Buffer.from('test-binary')])
    )
    await chmod(filePath, mode)
  }

  async function writeUniversalMachBinary(
    filePath: string,
    arches: Array<'x64' | 'arm64'>
  ) {
    await mkdir(dirname(filePath), { recursive: true })
    const header = Buffer.alloc(8 + arches.length * 20)
    header.set([0xca, 0xfe, 0xba, 0xbe])
    header.writeUInt32BE(arches.length, 4)
    arches.forEach((arch, index) => {
      header.writeUInt32BE(
        arch === 'arm64' ? 0x0100000c : 0x01000007,
        8 + index * 20
      )
    })
    await writeFile(filePath, header)
    await chmod(filePath, 0o755)
  }

  it('rejects an empty native-host target directory', async () => {
    await writeBinary(enginePath())
    await mkdir(dirname(hostPath()), { recursive: true })

    await expect(beforePack(context())).rejects.toThrow(
      /missing native-host binary: .*motrix-native-host$/
    )
  })

  it('rejects a target directory containing only legacy host files', async () => {
    await writeBinary(enginePath())
    await writeBinary(join(dirname(hostPath()), 'host.sh'))
    await writeFile(join(dirname(hostPath()), 'host.cjs'), 'legacy')

    await expect(beforePack(context())).rejects.toThrow(
      /missing native-host binary: .*motrix-native-host$/
    )
  })

  it('rejects a native-host path that is not a regular file', async () => {
    await writeBinary(enginePath())
    await mkdir(hostPath(), { recursive: true })

    await expect(beforePack(context())).rejects.toThrow(
      /native-host binary is not a regular file/
    )
  })

  it('rejects a Unix native-host without execute permission', async () => {
    await writeBinary(enginePath())
    await writeBinary(hostPath(), 0o644)

    await expect(beforePack(context())).rejects.toThrow(
      /native-host binary is not executable/
    )
  })

  it('rejects a non-binary file even when it has execute permission', async () => {
    await writeBinary(enginePath())
    await mkdir(dirname(hostPath()), { recursive: true })
    await writeFile(hostPath(), 'not-a-binary')
    await chmod(hostPath(), 0o755)

    await expect(beforePack(context())).rejects.toThrow(
      /native-host binary is not a darwin-x64 executable/
    )
  })

  it('rejects a valid executable for the wrong architecture', async () => {
    await writeBinary(enginePath())
    await writeBinary(hostPath(), 0o755, 'darwin', 'arm64')

    await expect(beforePack(context())).rejects.toThrow(
      /native-host binary is not a darwin-x64 executable/
    )
  })

  it('applies the same regular-file and permission checks to aria2', async () => {
    await writeBinary(enginePath(), 0o644)
    await writeBinary(hostPath())

    await expect(beforePack(context())).rejects.toThrow(
      /bundled aria2 engine is not executable/
    )
  })

  it('accepts concrete executable Unix binaries', async () => {
    await writeBinary(enginePath())
    await writeBinary(hostPath())

    await expect(beforePack(context())).resolves.toBeUndefined()
  })

  it('accepts Windows .exe files without Unix execute bits', async () => {
    await writeStage('win32')
    await writeBinary(enginePath('win32'), 0o644, 'win32')
    await writeBinary(hostPath('win32'), 0o644, 'win32')

    await expect(beforePack(context('win32'))).resolves.toBeUndefined()
  })

  it('accepts Windows arm64 PE files for the reserved target contract', async () => {
    await writeStage('win32', 'arm64')
    await writeBinary(enginePath('win32', 'arm64'), 0o644, 'win32', 'arm64')
    await writeBinary(hostPath('win32', 'arm64'), 0o644, 'win32', 'arm64')

    await expect(beforePack(context('win32', 3))).resolves.toBeUndefined()
  })

  it('rejects an MZ-only Windows file without a PE/COFF target header', async () => {
    await writeStage('win32')
    await writeBinary(enginePath('win32'), 0o644, 'win32')
    await mkdir(dirname(hostPath('win32')), { recursive: true })
    await writeFile(hostPath('win32'), Buffer.from('MZ-not-a-PE-file'))

    await expect(beforePack(context('win32'))).rejects.toThrow(
      /native-host binary is not a win32-x64 executable/
    )
  })

  it('accepts executable Linux ELF files', async () => {
    await writeStage('linux')
    await writeBinary(enginePath('linux'), 0o755, 'linux')
    await writeBinary(hostPath('linux'), 0o755, 'linux')

    await expect(beforePack(context('linux'))).resolves.toBeUndefined()
  })

  it('accepts executable Linux arm64 ELF files', async () => {
    await writeStage('linux', 'arm64')
    await writeBinary(enginePath('linux', 'arm64'), 0o755, 'linux', 'arm64')
    await writeBinary(hostPath('linux', 'arm64'), 0o755, 'linux', 'arm64')

    await expect(beforePack(context('linux', 3))).resolves.toBeUndefined()
  })

  it('accepts a universal Mach-O containing the requested target slice', async () => {
    await writeStage('darwin', 'arm64')
    await writeBinary(enginePath('darwin', 'arm64'), 0o755, 'darwin', 'arm64')
    await writeUniversalMachBinary(hostPath('darwin', 'arm64'), [
      'x64',
      'arm64',
    ])

    await expect(beforePack(context('darwin', 3))).resolves.toBeUndefined()
  })

  it('rejects a missing package stage before checking external resources', async () => {
    await rm(join(projectDir, 'dist/electron-app/.motrix-package-stage.json'))

    await expect(beforePack(context())).rejects.toThrow(
      'missing or invalid Electron package stage manifest'
    )
  })

  it('rejects a target-mismatched package stage', async () => {
    await writeStage('linux')

    await expect(beforePack(context())).rejects.toThrow(
      'stage target does not match darwin-x64'
    )
  })

  it('rejects a stale package stage', async () => {
    await writeFile(join(projectDir, 'dist/main/index.cjs'), 'changed')

    await expect(beforePack(context())).rejects.toThrow(
      'stage is stale for dist/main/index.cjs'
    )
  })

  it('rejects a package stage for another application version', async () => {
    await writeStage('darwin', 'x64', '1.2.2')
    await writeFile(
      join(projectDir, 'package.json'),
      `${JSON.stringify({ version: '1.2.3' })}\n`
    )

    await expect(beforePack(context())).rejects.toThrow(
      'stage version 1.2.2 does not match root version 1.2.3'
    )
  })
})
