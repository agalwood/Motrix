import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import lock from './fnos-runtime.lock.json' with { type: 'json' }
import {
  lockedDownload,
  prepareFnosProject,
  repositoryRoot,
  run,
  sha256,
} from './prepare-fnos-project.mjs'
import { verifyFnosPackage } from './verify-fnos-package.mjs'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    'app-dir': { type: 'string', default: 'dist/server-app' },
    'output-dir': { type: 'string' },
    arch: { type: 'string', default: process.arch },
    revision: { type: 'string', default: '0' },
  },
})
if (process.platform !== 'linux' || process.arch !== values.arch)
  throw new Error(
    'Build FPKs on matching Linux hardware so the bundled runtime can be smoke-tested'
  )
const project = await prepareFnosProject({
  appDir: values['app-dir'],
  outputDir: values['output-dir'] ?? `release/fnos/${values.arch}`,
  arch: values.arch,
  revision: values.revision,
})
await verifyFnosPackage(project, values.arch)
run(
  path.join(project, 'app/runtime/bin/node'),
  [
    'scripts/smoke-server-package.mjs',
    '--app-dir',
    path.join(project, 'app/server'),
    '--timeout-ms',
    '120000',
  ],
  { cwd: repositoryRoot }
)
const inContainer = await access('/.dockerenv').then(
  () => true,
  () => false
)
if (inContainer) {
  if (process.geteuid() !== 0)
    throw new Error(
      'Native lifecycle acceptance requires root inside the disposable build container'
    )
  run(
    path.join(project, 'app/runtime/bin/node'),
    ['scripts/smoke-fnos-package.mjs', '--project-dir', project],
    { cwd: repositoryRoot }
  )
} else {
  // Never create test accounts or privileged runtime files on the build host.
  const image = 'motrix-fnos-lifecycle:bookworm'
  run('docker', [
    'build',
    '--tag',
    image,
    '--file',
    path.join(repositoryRoot, 'packaging/fnos-lifecycle.Dockerfile'),
    path.join(repositoryRoot, 'packaging'),
  ])
  run('docker', [
    'run',
    '--rm',
    '--network=none',
    '--tmpfs',
    '/run:rw,nosuid,nodev,noexec',
    '--user',
    '0',
    '--mount',
    `type=bind,source=${project},target=/project,readonly`,
    '--mount',
    `type=bind,source=${path.join(repositoryRoot, 'scripts')},target=/scripts,readonly`,
    image,
    '/project/app/runtime/bin/node',
    '/scripts/smoke-fnos-package.mjs',
    '--project-dir',
    '/project',
  ])
}
const tool = await lockedDownload(
  lock.fnpack[`${process.platform}-${process.arch}`],
  path.join(repositoryRoot, 'node_modules/.cache/fnos')
)
await chmod(tool, 0o755)
const buildDir = await mkdtemp(path.join(path.dirname(project), '.fpk-'))
try {
  run(tool, ['build', '--directory', project], { cwd: buildDir })
  // Validate the bytes produced by fnpack, including its nested app archive.
  const unpacked = path.join(buildDir, 'unpacked')
  run('mkdir', ['-p', path.join(unpacked, 'app')])
  run('tar', ['-xf', path.join(buildDir, 'motrix.fpk'), '-C', unpacked])
  run('tar', [
    '-xzf',
    path.join(unpacked, 'app.tgz'),
    '-C',
    path.join(unpacked, 'app'),
  ])
  await verifyFnosPackage(unpacked, values.arch)
  const receipt = JSON.parse(
    await readFile(path.join(project, 'app/fnos-build.json'), 'utf8')
  )
  const filename = `Motrix-${receipt.packageVersion}-fnos-${values.arch}.fpk`
  const destination = path.join(path.dirname(project), filename)
  await rename(path.join(buildDir, 'motrix.fpk'), destination)
  await writeFile(
    `${destination}.sha256`,
    `${sha256(await readFile(destination))}  ${filename}\n`
  )
  console.log(`Built and verified ${destination}`)
} finally {
  await rm(buildDir, { recursive: true, force: true })
}
