import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapConfiguration,
  createBootstrapPackager,
} from './safari-bootstrap-package.mjs'
import { verifyNativeResources } from './safari-native-resources.mjs'
import {
  safariCIBuildNumber,
  validateSafariReleaseOptions,
  verifySafariReleaseResources,
} from './safari-release-policy.mjs'
import { safariVerificationProbe } from './safari-verification-probe.mjs'
import { verifyBuild } from './verify-build.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = new Set(process.argv.slice(2))
if (
  [...args].some(
    (arg) =>
      ![
        '--build',
        '--signed',
        '--archive',
        '--unsigned-archive',
        '--bootstrap',
        '--bootstrap-client-only',
        '--bootstrap-development-host',
        '--help',
      ].includes(arg)
  )
) {
  throw new Error(
    'Usage: node scripts/safari-native.mjs [--build] [--signed] [--archive] [--bootstrap | --bootstrap-client-only] [--bootstrap-development-host]'
  )
}
const archive = args.has('--archive')
const unsignedArchive = args.has('--unsigned-archive')
if (unsignedArchive && !archive)
  throw new Error('--unsigned-archive requires --archive')
validateSafariReleaseOptions(args, process.env)
const configuration = archive ? 'Release' : 'Debug'
if (args.has('--help')) {
  console.log(
    'Generate a macOS Safari native messaging development harness from dist/safari.\n' +
      'Use --build for an ad-hoc app, or --build --signed to use the signing configured in Xcode.\n' +
      'Add --bootstrap with MOTRIX_NATIVE_HOST_SOURCE to embed the signed Rust-backed XPC service.\n' +
      'Use --bootstrap-client-only when the Motrix desktop app owns the service; the Safari app retains its sandbox.\n' +
      'Add --archive with MOTRIX_SAFARI_RELEASE=1 for a universal Release archive without development probes; this does not export or upload.\n' +
      'CI: use --archive --unsigned-archive --build --bootstrap-client-only with MOTRIX_SAFARI_TEAM_ID and MOTRIX_SAFARI_BUILD_NUMBER; no signing credentials are required.\n' +
      'For local testing, --bootstrap-development-host removes only the container app sandbox so it can register this service.\n' +
      'Existing Xcode projects are preserved; extension resources and native handler sources are refreshed.\n' +
      'Set DEVELOPER_DIR for a custom Xcode installation. Projects and products are under .cache/safari-native.'
  )
  process.exit(0)
}
if (
  (args.has('--bootstrap') || args.has('--bootstrap-client-only')) &&
  (!args.has('--build') || (!args.has('--signed') && !unsignedArchive))
) {
  throw new Error('Bootstrap integration requires --build --signed')
}
if (args.has('--bootstrap') && args.has('--bootstrap-client-only')) {
  throw new Error('Choose either --bootstrap or --bootstrap-client-only')
}
if (args.has('--bootstrap-development-host') && !args.has('--bootstrap')) {
  throw new Error('--bootstrap-development-host requires --bootstrap')
}

if (process.platform !== 'darwin') {
  throw new Error('Safari native packaging requires macOS and full Xcode')
}
const developerDir =
  process.env.DEVELOPER_DIR ?? '/Applications/Xcode.app/Contents/Developer'
if (!existsSync(join(developerDir, 'usr/bin/xcodebuild'))) {
  throw new Error(
    'Full Xcode is missing; set DEVELOPER_DIR to its Contents/Developer directory'
  )
}
const environment = { ...process.env, DEVELOPER_DIR: developerDir }
const run = (command, commandArgs, capture = false) => {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: environment,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (exit ${result.status ?? result.signal})${capture ? `: ${result.stderr}` : ''}`
    )
  }
  return result.stdout
}

verifyBuild('safari')
const output = join(
  root,
  unsignedArchive ? '.cache/safari-ci' : '.cache/safari-native'
)
mkdirSync(output, { recursive: true })
const resources = join(output, 'web-extension')
// CI always generates a fresh project; it cannot inherit local Xcode settings.
const projectDirectory = unsignedArchive
  ? mkdtempSync(join(output, 'project-'))
  : join(output, 'project')
const appName = 'Motrix Extension for Safari'
const bundleIdentifier = 'app.motrix.safari'
const extensionIdentifier = `${bundleIdentifier}.extension`
const projectRoot = join(projectDirectory, appName)
const project = join(projectRoot, `${appName}.xcodeproj`)
mkdirSync(output, { recursive: true })
const revisionPath = join(output, 'build-number.json')
const previousRevision = existsSync(revisionPath)
  ? JSON.parse(readFileSync(revisionPath, 'utf8'))
  : 1
if (
  !Number.isSafeInteger(previousRevision) ||
  previousRevision < 1 ||
  previousRevision >= 65535
) {
  throw new Error('Invalid Safari development build number')
}
const buildRevision = unsignedArchive
  ? safariCIBuildNumber(process.env.MOTRIX_SAFARI_BUILD_NUMBER)
  : args.has('--build')
    ? previousRevision + 1
    : previousRevision
if (args.has('--build') && !unsignedArchive)
  writeFileSync(revisionPath, JSON.stringify(buildRevision))
// Only replace the script-owned resource staging directory, never dist/safari.
rmSync(resources, { recursive: true, force: true })
cpSync(join(root, 'dist/safari'), resources, { recursive: true })
const manifestPath = join(resources, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const marketingVersion = manifest.version
manifest.permissions.push('nativeMessaging')
manifest.name = 'Motrix Extension'
manifest.version = [
  ...manifest.version.split('.').slice(0, 3),
  buildRevision,
].join('.')
const backgroundScripts = manifest.background.scripts
const verificationPort = process.env.MOTRIX_SAFARI_VERIFY_PORT
if (verificationPort !== undefined) {
  safariVerificationProbe(verificationPort)
  console.log(
    `Development-only Safari Origin probe enabled on loopback port ${verificationPort}`
  )
}
// Preserve the stable resource entry already listed by existing Xcode projects.
// This module now runs in a background page, despite its historical filename.
writeFileSync(
  join(resources, 'service-worker-loader.js'),
  `${backgroundScripts.map((script) => `import ${JSON.stringify(`./${script}`)};`).join('\n')}\n`
)
writeFileSync(
  join(resources, 'native-worker.js'),
  archive
    ? "import './service-worker-loader.js';\n"
    : "import './service-worker-loader.js';\nimport './native-probe.js';\n"
)
manifest.background.scripts = ['native-worker.js']
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
if (archive) {
  // Keep the resource declared by the generated Xcode project, without diagnostics.
  writeFileSync(join(resources, 'native-probe.js'), 'export {}\n')
} else
  cpSync(
    join(root, 'native/safari/probe.js'),
    join(resources, 'native-probe.js')
  )
if (process.env.MOTRIX_SAFARI_FEATURE_PROBE === '1') {
  const probePath = join(resources, 'native-probe.js')
  writeFileSync(
    probePath,
    `${readFileSync(probePath, 'utf8')}\n${readFileSync(join(root, 'native/safari/Verification/feature-probe.js'), 'utf8')}`
  )
  const optionsPath = join(resources, 'options.html')
  writeFileSync(
    optionsPath,
    `${readFileSync(optionsPath, 'utf8')}\n<script type="module" src="native-probe.js"></script>\n`
  )
}
if (verificationPort !== undefined) {
  const probePath = join(resources, 'native-probe.js')
  writeFileSync(
    probePath,
    `${readFileSync(probePath, 'utf8')}\n${safariVerificationProbe(verificationPort)}`
  )
  writeFileSync(
    join(resources, 'popup.html'),
    '<!doctype html><meta charset="utf-8"><title>Motrix Native Verification</title><body style="width:440px;min-height:240px;padding:16px;font:14px system-ui"><h1>Motrix Native Verification</h1><pre id="verification-status" style="white-space:pre-wrap">Starting…</pre><script type="module" src="native-probe.js"></script>'
  )
}

if (archive) verifySafariReleaseResources(resources)

const packager = existsSync(
  join(developerDir, 'usr/bin/safari-web-extension-packager')
)
  ? 'safari-web-extension-packager'
  : 'safari-web-extension-converter'
if (!existsSync(project)) {
  run('/usr/bin/xcrun', [
    packager,
    resources,
    '--project-location',
    projectDirectory,
    '--app-name',
    appName,
    '--bundle-identifier',
    bundleIdentifier,
    '--swift',
    '--macos-only',
    '--copy-resources',
    '--no-open',
    '--no-prompt',
  ])
  // Xcode 27 derives the container ID from the display name even when an
  // explicit ID is supplied. Normalize only these generated identifiers;
  // subsequent runs preserve the Xcode-managed signing configuration.
  const generatedAppIdentifier = 'app.motrix.Motrix-Extension-for-Safari'
  for (const path of [
    join(project, 'project.pbxproj'),
    join(projectRoot, appName, 'ViewController.swift'),
  ]) {
    const content = readFileSync(path, 'utf8')
      .replaceAll(`${bundleIdentifier}.Extension`, extensionIdentifier)
      .replaceAll(generatedAppIdentifier, bundleIdentifier)
    writeFileSync(path, content)
  }
} else {
  // Preserve signing, capabilities, and other Xcode-managed project settings.
  // Resources are generated exclusively by this script, including hashed assets.
  const targetResources = join(projectRoot, `${appName} Extension`, 'Resources')
  if (!existsSync(join(targetResources, 'manifest.json'))) {
    throw new Error(
      `The Xcode template changed; missing manifest at ${targetResources}`
    )
  }
  rmSync(targetResources, { recursive: true, force: true })
  cpSync(resources, targetResources, { recursive: true })
}

if (unsignedArchive) {
  const projectFile = join(project, 'project.pbxproj')
  const data = JSON.parse(
    run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', projectFile], true)
  )
  // plutil can read OpenStep projects but can only write XML/binary plists.
  run('/usr/bin/plutil', ['-convert', 'xml1', projectFile])
  const products = new Map([
    ['com.apple.product-type.application', bundleIdentifier],
    ['com.apple.product-type.app-extension', extensionIdentifier],
  ])
  let targets = 0
  for (const object of Object.values(data.objects)) {
    if (object.isa !== 'PBXNativeTarget') continue
    const identifier = products.get(object.productType)
    if (!identifier)
      throw new Error(`Unexpected native target: ${object.productType}`)
    targets++
    for (const id of data.objects[object.buildConfigurationList]
      .buildConfigurations) {
      const settings = data.objects[id].buildSettings
      Object.assign(settings, {
        PRODUCT_BUNDLE_IDENTIFIER: identifier,
        DEVELOPMENT_TEAM: process.env.MOTRIX_SAFARI_TEAM_ID,
        CODE_SIGNING_ALLOWED: 'NO',
        ENABLE_APP_SANDBOX: 'YES',
        ENABLE_HARDENED_RUNTIME: 'YES',
      })
      run('/usr/bin/plutil', [
        '-replace',
        `objects.${id}.buildSettings`,
        '-json',
        JSON.stringify(settings),
        projectFile,
      ])
    }
  }
  if (targets !== 2)
    throw new Error('Expected exactly two Safari native targets')
}

const handlerPath = join(
  projectRoot,
  `${appName} Extension`,
  'SafariWebExtensionHandler.swift'
)
if (!existsSync(handlerPath)) {
  throw new Error(
    `The Xcode template changed; expected handler at ${handlerPath}`
  )
}
const coreDirectory = join(root, 'native/safari/Sources/SafariNativeCore')
const core = readdirSync(coreDirectory)
  .filter((name) => name.endsWith('.swift'))
  .sort()
  .map((name) => readFileSync(join(coreDirectory, name), 'utf8'))
  .join('\n')
const notifications = readFileSync(
  join(root, 'native/safari/NotificationDispatcher.swift'),
  'utf8'
)
// Share existing translations with the native app without adding Xcode-only resources.
const localeDirectory = join(root, 'src/shared/locales')
const nativeKeys = [
  'popup.settings',
  'options.notifications.masterLabel',
  'options.notifications.testBody',
  'options.notifications.nativeNotDetermined',
  'options.notifications.nativeDenied',
  'options.notifications.nativeAuthorized',
  'options.notifications.openSystemSettings',
]
const nativeLocales = Object.fromEntries(
  readdirSync(localeDirectory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const locale = JSON.parse(
        readFileSync(join(localeDirectory, name), 'utf8')
      )
      return [
        name.slice(0, -5),
        Object.fromEntries(
          nativeKeys.map((key) => {
            const value = key
              .split('.')
              .reduce((node, segment) => node?.[segment], locale)
            if (typeof value !== 'string')
              throw new Error(`Missing native translation: ${name} ${key}`)
            return [key, value]
          })
        ),
      ]
    })
)
const nativeStrings = `
import Foundation
enum NativeStrings {
    private static let values = try! JSONDecoder().decode([String: [String: String]].self, from: Data(base64Encoded: "${Buffer.from(JSON.stringify(nativeLocales)).toString('base64')}")!)
    static func value(_ key: String) -> String {
        let candidates = Array(values.keys)
        let language = Bundle.preferredLocalizations(from: candidates, forPreferences: Locale.preferredLanguages).first ?? "en-US"
        return values[language]?[key] ?? values["en-US"]?[key] ?? key
    }
}
`
const handler = readFileSync(
  join(root, 'native/safari/SafariWebExtensionHandler.swift'),
  'utf8'
)
const ipcDirectory = join(root, 'native/safari/Sources/SafariNativeIPC')
const ipc = readdirSync(ipcDirectory)
  .filter((name) => name.endsWith('.swift'))
  .sort()
  .map((name) => readFileSync(join(ipcDirectory, name), 'utf8'))
  .join('\n')
writeFileSync(
  handlerPath,
  `${core}\n${ipc}\n${nativeStrings}\n${notifications}\n${handler}`
)
writeFileSync(
  join(projectRoot, appName, 'AppDelegate.swift'),
  `${nativeStrings}\n${readFileSync(join(root, 'native/safari/AppDelegate.swift'), 'utf8')}`
)
cpSync(
  join(root, 'native/safari/ViewController.swift'),
  join(projectRoot, appName, 'ViewController.swift')
)

const extensionInfo = join(projectRoot, `${appName} Extension`, 'Info.plist')
const containingInfo = join(projectRoot, appName, 'Info.plist')
let embedBootstrap
let signedSettings
let signedConfiguration
if (unsignedArchive)
  signedConfiguration = bootstrapConfiguration(
    process.env.MOTRIX_SAFARI_TEAM_ID
  )
if (args.has('--signed')) {
  signedSettings = JSON.parse(
    run(
      '/usr/bin/xcrun',
      [
        'xcodebuild',
        '-project',
        project,
        '-scheme',
        appName,
        '-configuration',
        configuration,
        '-showBuildSettings',
        '-json',
      ],
      true
    )
  ).find((entry) => entry.target === appName)?.buildSettings
  if (!signedSettings)
    throw new Error('Cannot resolve the containing app signing settings')
  signedConfiguration = bootstrapConfiguration(signedSettings.DEVELOPMENT_TEAM)
}
for (const infoPath of [extensionInfo, containingInfo]) {
  const info = JSON.parse(
    run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPath], true)
  )
  if (signedConfiguration) {
    run('/usr/bin/plutil', [
      '-replace',
      'MotrixNotificationGroup',
      '-string',
      signedConfiguration.AppGroupIdentifier,
      infoPath,
    ])
  } else if ('MotrixNotificationGroup' in info) {
    run('/usr/bin/plutil', ['-remove', 'MotrixNotificationGroup', infoPath])
  }
  // P0 must prove direct delivery and click ownership before advertising it.
  run('/usr/bin/plutil', [
    '-replace',
    'MotrixNotificationDelivery',
    '-string',
    'candidate',
    infoPath,
  ])
}
if (args.has('--bootstrap') || args.has('--bootstrap-client-only')) {
  if ((!signedSettings && !unsignedArchive) || !signedConfiguration)
    throw new Error('Missing signed bootstrap configuration')
  if (args.has('--bootstrap')) {
    embedBootstrap = createBootstrapPackager({
      root,
      output,
      environment,
      configuration: signedConfiguration,
      developmentHost: args.has('--bootstrap-development-host'),
      identity:
        signedSettings.EXPANDED_CODE_SIGN_IDENTITY ||
        signedSettings.CODE_SIGN_IDENTITY,
    })
  }
  run('/usr/bin/plutil', [
    '-replace',
    'MotrixBootstrapIPC',
    '-json',
    JSON.stringify(signedConfiguration),
    extensionInfo,
  ])
} else {
  const info = JSON.parse(
    run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', extensionInfo], true)
  )
  if ('MotrixBootstrapIPC' in info)
    run('/usr/bin/plutil', ['-remove', 'MotrixBootstrapIPC', extensionInfo])
}

// The containing app and the Safari extension have distinct display names.
run('/usr/bin/plutil', [
  '-replace',
  'CFBundleDisplayName',
  '-string',
  'Motrix Extension',
  join(projectRoot, `${appName} Extension`, 'Info.plist'),
])

console.log(`Updated project: ${project}`)
if (args.has('--build')) {
  const archivePath = join(
    output,
    'archives',
    `${appName}-${buildRevision}.xcarchive`
  )
  const builtApp = resolve(
    archive ? archivePath : output,
    archive ? 'Products/Applications' : 'DerivedData/Build/Products/Debug',
    `${appName}.app`
  )
  // Xcode's incremental copy steps do not delete a previously embedded helper.
  rmSync(builtApp, { recursive: true, force: true })
  run('/usr/bin/xcrun', [
    'xcodebuild',
    '-project',
    project,
    '-scheme',
    appName,
    '-configuration',
    configuration,
    '-destination',
    archive ? 'generic/platform=macOS' : 'platform=macOS',
    '-derivedDataPath',
    join(output, 'DerivedData'),
    ...(unsignedArchive
      ? [
          'CODE_SIGNING_ALLOWED=NO',
          'CODE_SIGNING_REQUIRED=NO',
          'CODE_SIGN_IDENTITY=',
        ]
      : args.has('--signed')
        ? []
        : [
            'CODE_SIGN_IDENTITY=-',
            'CODE_SIGN_STYLE=Manual',
            'DEVELOPMENT_TEAM=',
            'CODE_SIGN_ENTITLEMENTS=',
          ]),
    'MACOSX_DEPLOYMENT_TARGET=13.0',
    `MARKETING_VERSION=${marketingVersion}`,
    `CURRENT_PROJECT_VERSION=${buildRevision}`,
    ...(archive
      ? [
          '-archivePath',
          archivePath,
          'ARCHS=arm64 x86_64',
          'ONLY_ACTIVE_ARCH=NO',
          'INFOPLIST_KEY_LSApplicationCategoryType=public.app-category.utilities',
          'archive',
        ]
      : ['build']),
  ])
  verifyNativeResources(
    resources,
    join(
      builtApp,
      'Contents/PlugIns',
      `${appName} Extension.appex`,
      'Contents/Resources'
    )
  )
  embedBootstrap?.(builtApp)
  if (archive)
    verifySafariReleaseResources(
      join(
        builtApp,
        'Contents/PlugIns',
        `${appName} Extension.appex`,
        'Contents/Resources'
      )
    )
  if (args.has('--signed')) {
    // Fail rather than silently reporting success for an ad-hoc build.
    run('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      '-R',
      '=anchor apple generic',
      builtApp,
    ])
  }
  console.log(`Built app: ${builtApp}`)
  if (archive)
    console.log(`Release archive (not exported or uploaded): ${archivePath}`)
}
