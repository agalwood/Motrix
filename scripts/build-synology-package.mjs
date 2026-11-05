import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
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
import lock from './synology-runtime.lock.json' with { type: 'json' }
import {
  payloadInventory,
  verifySynologyPackage,
  verifySynologyProject,
} from './verify-synology-package.mjs'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    'app-dir': { type: 'string' },
    'output-dir': { type: 'string' },
    revision: { type: 'string' },
  },
})
const project = await prepareSynologyProject({
  appDir: values['app-dir'],
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
const sdkArchive = await lockedDownload(
  lock.toolchain,
  path.join(repositoryRoot, 'node_modules/.cache/synology')
)
const sdk = path.join(output, 'sdk')
async function writableDirectories(directory) {
  if (!(await lstat(directory)).isDirectory()) return
  await chmod(directory, 0o755)
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name)
    if ((await lstat(file)).isDirectory()) await writableDirectories(file)
  }
}
await mkdir(sdk) // A fresh build owns its SDK extraction.
try {
  run('tar', ['-xJf', sdkArchive, '-C', sdk])
  await writableDirectories(sdk)
  const abiReport = path.join(output, 'synology-abi.json')
  const invoke = (root) => {
    const lifecycleSmoke = () =>
      run('docker', [
        'run',
        '--rm',
        '--platform',
        'linux/amd64',
        '--network=none',
        '--tmpfs',
        '/volume1:rw,nosuid,nodev',
        '--mount',
        `type=bind,source=${root},target=/spk,readonly`,
        '--mount',
        `type=bind,source=${path.join(repositoryRoot, 'scripts')},target=/scripts,readonly`,
        'rust:1.94.1',
        '/spk/app/runtime/bin/node',
        '/scripts/smoke-synology-package.mjs',
        '--project-dir',
        '/spk',
      ])
    if (process.platform === 'linux' && process.arch === 'x64') {
      run('python3', [
        path.join(repositoryRoot, 'scripts/verify_synology_abi.py'),
        path.join(root, 'app'),
        path.join(sdk, 'x86_64-pc-linux-gnu'),
        abiReport,
      ])
      run(path.join(root, 'app/runtime/bin/node'), [
        path.join(repositoryRoot, 'scripts/smoke-server-package.mjs'),
        '--app-dir',
        path.join(root, 'app/server'),
        '--timeout-ms',
        '120000',
      ])
    } else {
      run('docker', [
        'run',
        '--rm',
        '--platform',
        'linux/amd64',
        '--network=none',
        '--mount',
        `type=bind,source=${root},target=/spk,readonly`,
        '--mount',
        `type=bind,source=${sdk},target=/sdk,readonly`,
        '--mount',
        `type=bind,source=${path.join(repositoryRoot, 'scripts')},target=/scripts,readonly`,
        '--mount',
        `type=bind,source=${output},target=/reports`,
        'rust:1.94.1',
        'sh',
        '-c',
        'python3 /scripts/verify_synology_abi.py /spk/app /sdk/x86_64-pc-linux-gnu /reports/synology-abi.json && /spk/app/runtime/bin/node /scripts/smoke-server-package.mjs --app-dir /spk/app/server --timeout-ms 120000',
      ])
    }
    lifecycleSmoke()
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
    `Motrix-${receipt.version}-${receipt.revision}-dsm-x64.spk`
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
  // Execute ABI and HTTP/BT smoke checks against bytes extracted from the SPK.
  await verifySynologyPackage(file, invoke)
  await cp(abiReport, `${file}.abi.json`)
  await writeFile(
    `${file}.sha256`,
    `${sha256(await readFile(file))}  ${path.basename(file)}\n`
  )
  console.log(`Built and verified ${file}`)
} finally {
  await rm(sdk, { recursive: true, force: true })
}
