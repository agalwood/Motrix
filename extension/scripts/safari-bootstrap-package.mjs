import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

export const bootstrapServiceIdentifier = 'app.motrix.safari.bootstrap'

export function developmentHostEntitlements(entitlements) {
  const result = { ...entitlements }
  delete result['com.apple.security.app-sandbox']
  return result
}

export function bootstrapConfiguration(team) {
  if (!/^[A-Z0-9]{10}$/.test(team ?? '')) {
    throw new Error(
      'A valid Xcode development Team is required for bootstrap packaging'
    )
  }
  return {
    TeamIdentifier: team,
    ClientBundleIdentifier: 'app.motrix.safari.extension',
    ServiceBundleIdentifier: bootstrapServiceIdentifier,
    AppGroupIdentifier: `${team}.app.motrix.shared`,
  }
}

export function bootstrapLaunchAgent(configuration) {
  return {
    Label: bootstrapServiceIdentifier,
    BundleProgram: 'Contents/Library/LaunchServices/MotrixSafariBootstrap',
    MachServices: { [`${configuration.AppGroupIdentifier}.bootstrap`]: true },
    ProcessType: 'Interactive',
  }
}

export function createBootstrapPackager({
  root,
  output,
  environment,
  configuration,
  identity,
  developmentHost = false,
}) {
  const source = process.env.MOTRIX_NATIVE_HOST_SOURCE
  if (
    !source ||
    !existsSync(join(source, 'include/motrix_safari_bootstrap.h'))
  ) {
    throw new Error(
      'Set MOTRIX_NATIVE_HOST_SOURCE to the native-host package with Safari bootstrap support'
    )
  }
  if (!identity || identity === '-')
    throw new Error('Bootstrap requires an Apple signing identity')
  const run = (command, args, capture = false) => {
    const result = spawnSync(command, args, {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    if (result.error) throw result.error
    if (result.status !== 0)
      throw new Error(
        `${command} failed: ${capture ? result.stderr : result.status}`
      )
    return result.stdout?.trim()
  }
  const directory = join(output, 'bootstrap')
  mkdirSync(directory, { recursive: true })
  const configSource = join(directory, 'SignedConfiguration.swift')
  const quote = (value) => JSON.stringify(value)
  writeFileSync(
    configSource,
    `func signedBootstrapConfiguration() throws -> BootstrapIPCConfiguration {
    try BootstrapIPCConfiguration(
        teamIdentifier: ${quote(configuration.TeamIdentifier)},
        clientBundleIdentifier: ${quote(configuration.ClientBundleIdentifier)},
        serviceBundleIdentifier: ${quote(configuration.ServiceBundleIdentifier)},
        appGroupIdentifier: ${quote(configuration.AppGroupIdentifier)}
    )
}
`
  )
  const rustOutput = join(directory, 'rust')
  run('cargo', [
    'rustc',
    '--manifest-path',
    resolve(source, 'Cargo.toml'),
    '--locked',
    '--release',
    '--lib',
    '--features',
    'safari-bootstrap',
    '--crate-type',
    'staticlib',
    '--target-dir',
    rustOutput,
  ])
  const executable = join(directory, 'MotrixSafariBootstrap')
  const ipc = join(root, 'native/safari/Sources/SafariNativeIPC')
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  const sdk = run(
    '/usr/bin/xcrun',
    ['--sdk', 'macosx', '--show-sdk-path'],
    true
  )
  run('/usr/bin/xcrun', [
    'swiftc',
    '-O',
    '-swift-version',
    '6',
    '-parse-as-library',
    '-target',
    `${architecture}-apple-macos13.0`,
    '-sdk',
    sdk,
    '-module-cache-path',
    join(directory, 'swift-module-cache'),
    '-import-objc-header',
    resolve(source, 'include/motrix_safari_bootstrap.h'),
    ...readdirSync(ipc)
      .filter((name) => name.endsWith('.swift'))
      .sort()
      .map((name) => join(ipc, name)),
    configSource,
    join(root, 'native/safari/BootstrapServiceMain.swift'),
    join(rustOutput, 'release/libmotrix_native_host.a'),
    '-framework',
    'Security',
    '-o',
    executable,
  ])
  const entitlements = join(directory, 'service.entitlements')
  writeFileSync(
    entitlements,
    JSON.stringify({
      'com.apple.security.application-groups': [
        configuration.AppGroupIdentifier,
      ],
    })
  )
  run('/usr/bin/plutil', ['-convert', 'xml1', entitlements])
  run('/usr/bin/codesign', [
    '--force',
    '--sign',
    identity,
    '--identifier',
    bootstrapServiceIdentifier,
    '--options',
    'runtime',
    '--entitlements',
    entitlements,
    executable,
  ])

  return (app) => {
    const helpers = join(app, 'Contents/Library/LaunchServices')
    const agents = join(app, 'Contents/Library/LaunchAgents')
    mkdirSync(helpers, { recursive: true })
    mkdirSync(agents, { recursive: true })
    copyFileSync(executable, join(helpers, 'MotrixSafariBootstrap'))
    const plist = join(agents, `${bootstrapServiceIdentifier}.plist`)
    writeFileSync(plist, JSON.stringify(bootstrapLaunchAgent(configuration)))
    run('/usr/bin/plutil', ['-convert', 'xml1', plist])
    const signingOptions = [
      '--preserve-metadata=identifier,entitlements,requirements,flags,runtime',
    ]
    if (developmentHost) {
      const hostEntitlements = join(directory, 'development-host.entitlements')
      writeFileSync(
        hostEntitlements,
        run(
          '/usr/bin/codesign',
          ['-d', '--entitlements', '-', '--xml', app],
          true
        )
      )
      run('/usr/bin/plutil', ['-convert', 'json', hostEntitlements])
      writeFileSync(
        hostEntitlements,
        JSON.stringify(
          developmentHostEntitlements(
            JSON.parse(readFileSync(hostEntitlements, 'utf8'))
          )
        )
      )
      run('/usr/bin/plutil', ['-convert', 'xml1', hostEntitlements])
      signingOptions.splice(
        0,
        1,
        '--preserve-metadata=identifier,requirements,flags,runtime',
        '--entitlements',
        hostEntitlements
      )
    }
    // Adding nested signed code changes the enclosing resource seal.
    run('/usr/bin/codesign', [
      '--force',
      '--sign',
      identity,
      ...signingOptions,
      app,
    ])
    const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${configuration.TeamIdentifier}" and identifier "${bootstrapServiceIdentifier}" and entitlement["com.apple.security.application-groups"] = "${configuration.AppGroupIdentifier}"`
    run('/usr/bin/codesign', [
      '--verify',
      '--strict',
      '-R',
      requirement,
      join(helpers, 'MotrixSafariBootstrap'),
    ])
  }
}
