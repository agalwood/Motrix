import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { testBootstrapIntegration } from './test-integration.mjs'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { arch: { type: 'string' }, test: { type: 'boolean' } },
})
const arch = values.arch ?? process.arch
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) {
  throw new Error('Safari bootstrap requires macOS and --arch arm64 or x64')
}
const root = fileURLToPath(new URL('../../', import.meta.url))
const source = join(root, 'packages/safari-bootstrap')
const output = join(source, 'dist', `darwin-${arch}`)
const intermediate = join(source, '.build', arch)
mkdirSync(output, { recursive: true })
mkdirSync(intermediate, { recursive: true })
const configuration = JSON.parse(
  readFileSync(join(source, 'configuration.json'), 'utf8')
)
const generated = join(intermediate, 'SignedConfiguration.swift')
writeFileSync(
  generated,
  `func signedBootstrapConfiguration() throws -> BootstrapIPCConfiguration {
    try BootstrapIPCConfiguration(
        teamIdentifier: ${JSON.stringify(configuration.teamIdentifier)},
        clientBundleIdentifier: ${JSON.stringify(configuration.clientBundleIdentifier)},
        serviceBundleIdentifier: ${JSON.stringify(configuration.serviceBundleIdentifier)},
        appGroupIdentifier: ${JSON.stringify(configuration.appGroupIdentifier)}
    )
}
`
)
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (result.error || result.status !== 0) throw new Error(`${command} failed`)
  return result.stdout.trim()
}
const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64'
const target = `${cpu}-apple-darwin`
const rustOutput = join(intermediate, 'rust')
run('cargo', [
  'rustc',
  '--manifest-path',
  'packages/native-host/Cargo.toml',
  '--locked',
  '--release',
  '--lib',
  '--features',
  'safari-bootstrap',
  '--crate-type',
  'staticlib',
  '--target',
  target,
  '--target-dir',
  rustOutput,
])
const sdk = run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'])
const ipc = join(source, 'Sources/SafariNativeIPC')
const common = [
  'swiftc',
  '-O',
  '-swift-version',
  '6',
  '-parse-as-library',
  '-target',
  `${arch === 'x64' ? 'x86_64' : arch}-apple-macos13.0`,
  '-sdk',
  sdk,
  '-module-cache-path',
  join(intermediate, 'swift-module-cache'),
  ...readdirSync(ipc)
    .filter((name) => name.endsWith('.swift'))
    .sort()
    .map((name) => join(ipc, name)),
  generated,
  '-framework',
  'Security',
]
run('/usr/bin/xcrun', [
  ...common,
  '-import-objc-header',
  join(root, 'packages/native-host/include/motrix_safari_bootstrap.h'),
  join(source, 'Native/NativeBootstrapResolver.swift'),
  join(source, 'Executables/BootstrapServiceMain.swift'),
  join(rustOutput, target, 'release/libmotrix_native_host.a'),
  '-o',
  join(output, 'MotrixSafariBootstrap'),
])
run('/usr/bin/xcrun', [
  ...common,
  join(source, 'Executables/DesktopBootstrapRegistrar.swift'),
  '-framework',
  'ServiceManagement',
  '-o',
  join(output, 'MotrixSafariRegistrar'),
])
console.log(`Built unsigned Safari desktop helpers for ${arch}`)

if (values.test) {
  if (arch !== process.arch)
    throw new Error('Integration tests require the runner architecture')
  const probe = join(intermediate, 'bootstrap-probe')
  run('/usr/bin/xcrun', [
    ...common,
    '-import-objc-header',
    join(root, 'packages/native-host/include/motrix_safari_bootstrap.h'),
    join(source, 'Native/NativeBootstrapResolver.swift'),
    join(source, 'Tests/FFI/BootstrapProbe.swift'),
    join(rustOutput, target, 'release/libmotrix_native_host.a'),
    '-o',
    probe,
  ])
  await testBootstrapIntegration(probe)
}
