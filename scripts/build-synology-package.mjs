import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  lockedDownload,
  repositoryRoot,
  run,
  sha256,
} from './prepare-fnos-project.mjs'
import { prepareSynologyProject } from './prepare-synology-project.mjs'
import { synologyTarget } from './synology-target.mjs'
import {
  payloadInventory,
  verifySynologyPackage,
  verifySynologyProject,
} from './verify-synology-package.mjs'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    arch: { type: 'string' },
    'app-dir': { type: 'string' },
    'output-dir': { type: 'string' },
    revision: { type: 'string' },
  },
})
const project = await prepareSynologyProject({
  appDir: values['app-dir'],
  arch: values.arch,
  outputDir: values['output-dir'],
  revision: values.revision,
})
const app = path.join(project, 'app')
const inventory = await payloadInventory(app)
await writeFile(
  path.join(app, 'payload-sha256.json'),
  `${JSON.stringify(inventory, null, 2)}\n`
)
const receipt = await verifySynologyProject(project)
const output = path.dirname(project)
const arch = receipt.architecture
const target = synologyTarget(arch)
const sdk = path.join(output, 'sdk')
async function writableDirectories(directory) {
  if (!(await lstat(directory)).isDirectory()) return
  await chmod(directory, 0o755)
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name)
    if ((await lstat(file)).isDirectory()) await writableDirectories(file)
  }
}
const invoke = async (root) => {
  const mounts = [
    'run',
    '--rm',
    '--platform',
    target.dockerPlatform,
    '--network=none',
    '--mount',
    `type=bind,source=${root},target=/spk,readonly`,
    '--mount',
    `type=bind,source=${path.join(repositoryRoot, 'scripts')},target=/scripts,readonly`,
  ]
  const native = process.platform === 'linux' && process.arch === arch
  const image = arch === 'arm64' ? 'motrix-dsm-abi:arm64' : 'rust:1.94.1'
  if (!native && arch === 'arm64') {
    run('docker', [
      'build',
      '--platform',
      target.dockerPlatform,
      '--tag',
      image,
      '--file',
      path.join(repositoryRoot, 'packaging/synology-abi.Dockerfile'),
      path.join(repositoryRoot, 'packaging/synology'),
    ])
  }
  const reports = {}
  for (const [platform, profile] of Object.entries(target.platforms)) {
    const sdkArchive = await lockedDownload(
      profile.toolchain,
      path.join(repositoryRoot, 'node_modules/.cache/synology')
    )
    await mkdir(sdk)
    try {
      run('tar', ['-xJf', sdkArchive, '-C', sdk])
      await writableDirectories(sdk)
      const reportName = `synology-${platform}-abi.json`
      if (native) {
        run('python3', [
          path.join(repositoryRoot, 'scripts/verify_synology_abi.py'),
          path.join(root, 'app'),
          sdk,
          path.join(output, reportName),
          arch,
          platform,
        ])
      } else {
        run('docker', [
          ...mounts,
          '--mount',
          `type=bind,source=${sdk},target=/sdk,readonly`,
          '--mount',
          `type=bind,source=${output},target=/reports`,
          image,
          'python3',
          '/scripts/verify_synology_abi.py',
          '/spk/app',
          '/sdk',
          `/reports/${reportName}`,
          arch,
          platform,
        ])
      }
      reports[platform] = JSON.parse(
        await readFile(path.join(output, reportName), 'utf8')
      )
    } finally {
      await rm(sdk, { recursive: true, force: true })
    }
  }
  run('docker', [
    ...mounts,
    'rust:1.94.1',
    '/spk/app/runtime/bin/node',
    '/scripts/smoke-server-package.mjs',
    '--app-dir',
    '/spk/app/server',
    '--timeout-ms',
    '120000',
  ])
  run('docker', [
    ...mounts,
    '--tmpfs',
    '/volume1:rw,nosuid,nodev',
    'rust:1.94.1',
    '/spk/app/runtime/bin/node',
    '/scripts/smoke-synology-package.mjs',
    '--project-dir',
    '/spk',
  ])
  return reports
}
const payload = path.join(project, 'package.tgz')
run('tar', ['-czf', payload, '-C', app, '.'], {
  env: { ...process.env, COPYFILE_DISABLE: '1' },
})
const infoPath = path.join(project, 'INFO')
await writeFile(
  infoPath,
  (await readFile(infoPath, 'utf8')).replace(
    '@CHECKSUM@',
    createHash('md5')
      .update(await readFile(payload))
      .digest('hex')
  )
)
const file = path.join(
  output,
  `Motrix-${receipt.version}-${receipt.revision}-dsm-${arch}.spk`
)
run(
  'tar',
  [
    '-cf',
    file,
    '-C',
    project,
    'INFO',
    'package.tgz',
    'scripts',
    'conf',
    'WIZARD_UIFILES',
    'LICENSE',
    'PACKAGE_ICON.PNG',
    'PACKAGE_ICON_256.PNG',
  ],
  { env: { ...process.env, COPYFILE_DISABLE: '1' } }
)
// Execute every profile against this single extracted SPK before writing its
// checksum and release ABI receipt.
let platforms
await verifySynologyPackage(file, async (root) => {
  platforms = await invoke(root)
})
const digest = sha256(await readFile(file))
await writeFile(
  `${file}.abi.json`,
  `${JSON.stringify({ schemaVersion: 3, architecture: arch, spkSha256: digest, platforms }, null, 2)}\n`
)
await writeFile(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`)
console.log(`Built and verified ${file}`)
