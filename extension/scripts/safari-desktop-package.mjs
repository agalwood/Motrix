import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  bootstrapConfiguration,
  createBootstrapPackager,
} from './safari-bootstrap-package.mjs'

const { values } = parseArgs({
  options: {
    'source-app': { type: 'string' },
    identity: { type: 'string' },
    team: { type: 'string' },
    help: { type: 'boolean' },
  },
})
if (values.help) {
  console.log(
    'Prepare a signed Motrix desktop copy with Safari bootstrap service and registration tool.\n' +
      'MOTRIX_NATIVE_HOST_SOURCE=/path/to/native-host node scripts/safari-desktop-package.mjs --source-app /path/to/Motrix.app --team TEAMID --identity SIGNING_IDENTITY\n' +
      'The source app is preserved. Output is .cache/safari-native/desktop/Motrix.app; nothing is installed, launched, or registered.'
  )
  process.exit(0)
}
if (
  process.platform !== 'darwin' ||
  !values['source-app'] ||
  !values.identity ||
  !values.team
) {
  throw new Error('macOS, --source-app, --identity, and --team are required')
}
const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, '.cache/safari-native')
const app = join(output, 'desktop/Motrix.app')
const source = resolve(values['source-app'])
if (
  source === app ||
  source.startsWith(`${app}/`) ||
  !existsSync(join(source, 'Contents/Info.plist'))
) {
  throw new Error(
    'Use a separate, existing signed Motrix desktop app as the source'
  )
}
const configuration = bootstrapConfiguration(values.team)
const environment = {
  ...process.env,
  DEVELOPER_DIR:
    process.env.DEVELOPER_DIR ?? '/Applications/Xcode.app/Contents/Developer',
}
function run(command, args, input) {
  const result = spawnSync(command, args, {
    env: environment,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr}`)
  return result.stdout
}
const parentRequirement = `=anchor apple generic and certificate leaf[subject.OU] = "${values.team}" and identifier "app.motrix.native"`
if (existsSync(app)) {
  // A registered BundleProgram points inside this copy. Never replace live code.
  run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '-R',
    parentRequirement,
    app,
  ])
  const existingRegistrar = join(app, 'Contents/MacOS/MotrixSafariRegistrar')
  if (!existsSync(existingRegistrar)) {
    throw new Error('Existing desktop output has no trusted registration tool')
  }
  const registration = JSON.parse(run(existingRegistrar, ['--status']))
  if (
    registration.protocolVersion !== 1 ||
    !['not-registered', 'not-found'].includes(registration.status)
  ) {
    throw new Error(
      'Unregister the existing desktop bootstrap service before rebuilding this copy'
    )
  }
}
run('/usr/bin/codesign', [
  '--verify',
  '--deep',
  '--strict',
  '-R',
  parentRequirement,
  source,
])
const signedEntitlements = run('/usr/bin/codesign', [
  '-d',
  '--entitlements',
  '-',
  '--xml',
  source,
])
const entitlements = JSON.parse(
  run(
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', '-'],
    signedEntitlements
  )
)
if (entitlements['com.apple.security.app-sandbox'] === true) {
  throw new Error(
    'The source desktop app must already be unsandboxed; this command never removes its sandbox'
  )
}
const embed = createBootstrapPackager({
  root,
  output,
  environment,
  configuration,
  identity: values.identity,
})
const ipc = join(root, 'native/safari/Sources/SafariNativeIPC')
const registrar = join(output, 'bootstrap/MotrixSafariRegistrar')
const sdk = run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path']).trim()
run('/usr/bin/xcrun', [
  'swiftc',
  '-O',
  '-swift-version',
  '6',
  '-parse-as-library',
  '-target',
  `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
  '-sdk',
  sdk,
  '-module-cache-path',
  join(output, 'bootstrap/swift-module-cache'),
  ...readdirSync(ipc)
    .filter((name) => name.endsWith('.swift'))
    .sort()
    .map((name) => join(ipc, name)),
  join(output, 'bootstrap/SignedConfiguration.swift'),
  join(root, 'native/safari/DesktopBootstrapRegistrar.swift'),
  '-framework',
  'Security',
  '-framework',
  'ServiceManagement',
  '-o',
  registrar,
])
run('/usr/bin/codesign', [
  '--force',
  '--sign',
  values.identity,
  '--identifier',
  'app.motrix.safari.registration',
  '--options',
  'runtime',
  '--entitlements',
  join(output, 'bootstrap/service.entitlements'),
  registrar,
])
// Replace only this script's output, after all source and compilation checks pass.
mkdirSync(join(output, 'desktop'), { recursive: true })
rmSync(app, { recursive: true, force: true })
cpSync(source, app, { recursive: true, verbatimSymlinks: true })
cpSync(registrar, join(app, 'Contents/MacOS/MotrixSafariRegistrar'))
embed(app)
run('/usr/bin/codesign', [
  '--verify',
  '--deep',
  '--strict',
  '-R',
  parentRequirement,
  app,
])
console.log(`Prepared desktop app: ${app}`)
console.log(
  'The Safari extension container remains sandboxed and independently installed. No background service was registered.'
)
