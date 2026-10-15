import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { bootstrapConfiguration } from './safari-bootstrap-package.mjs'
import { installSafariApp } from './safari-install-transaction.mjs'

const appName = 'Motrix Extension for Safari'
const extensionName = `${appName} Extension.appex`
const extensionPath = (app) => join(app, 'Contents/PlugIns', extensionName)
const launchServices =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

function run(command, args, input, allowMissing = false) {
  const result = spawnSync(command, args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (
    result.status !== 0 &&
    !(
      allowMissing &&
      result.status === 1 &&
      /(?<!\d)-10814(?!\d)/.test(`${result.stdout}\n${result.stderr}`)
    )
  )
    throw new Error(
      `${command} failed (${result.status}): ${result.stderr || result.stdout}`
    )
  return result.stdout
}

const readPlist = (path) =>
  JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path]))

// Include every file, including nested signatures, to make repeat installs a no-op.
function fingerprintBundle(app) {
  const hash = createHash('sha256')
  function visit(relative) {
    for (const entry of readdirSync(join(app, relative), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name)
      hash.update(`${name}\0`)
      if (entry.isDirectory()) visit(name)
      else if (entry.isFile()) {
        const contents = readFileSync(join(app, name))
        hash.update(`${contents.length}\0`)
        hash.update(contents)
      } else {
        throw new Error(
          'Safari app contents must be regular files and directories'
        )
      }
    }
  }
  visit('')
  return hash.digest('hex')
}

/** This installer accepts only the sandboxed, client-only signed development app. */
export function verifySafariApp(app, team) {
  const configuration = bootstrapConfiguration(team)
  const extension = extensionPath(app)
  for (const [bundle, identifier, displayName] of [
    [app, 'app.motrix.safari', appName],
    [extension, configuration.ClientBundleIdentifier, 'Motrix Extension'],
  ]) {
    const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${team}" and identifier "${identifier}"`
    run('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      '-R',
      requirement,
      bundle,
    ])
    const info = readPlist(join(bundle, 'Contents/Info.plist'))
    if (
      info.CFBundleIdentifier !== identifier ||
      info.CFBundleDisplayName !== displayName
    )
      throw new Error('Unexpected Safari bundle identity or display name')
    const entitlements = JSON.parse(
      run(
        '/usr/bin/plutil',
        ['-convert', 'json', '-o', '-', '-'],
        run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', bundle])
      )
    )
    const groups = entitlements['com.apple.security.application-groups']
    if (
      entitlements['com.apple.security.app-sandbox'] !== true ||
      !Array.isArray(groups) ||
      !groups.includes(configuration.AppGroupIdentifier)
    )
      throw new Error(
        'Both Safari targets must retain their sandbox and App Group'
      )
  }
  const appInfo = readPlist(join(app, 'Contents/Info.plist'))
  const extensionInfo = readPlist(join(extension, 'Contents/Info.plist'))
  const ipc = extensionInfo.MotrixBootstrapIPC
  if (
    !ipc ||
    Object.keys(ipc).length !== Object.keys(configuration).length ||
    Object.entries(configuration).some(([key, value]) => ipc[key] !== value) ||
    extensionInfo.NSExtension?.NSExtensionPointIdentifier !==
      'com.apple.Safari.web-extension'
  )
    throw new Error('Unexpected signed bootstrap IPC configuration')
  if (
    existsSync(join(app, 'Contents/Library/LaunchAgents')) ||
    existsSync(join(app, 'Contents/Library/LaunchServices')) ||
    readdirSync(join(app, 'Contents/PlugIns')).length !== 1
  )
    throw new Error(
      'Install a client-only Safari app without embedded services'
    )
  const build = Number(appInfo.CFBundleVersion)
  if (
    !/^[1-9][0-9]*$/.test(appInfo.CFBundleVersion) ||
    !Number.isSafeInteger(build) ||
    build > 65535 ||
    extensionInfo.CFBundleVersion !== appInfo.CFBundleVersion
  )
    throw new Error('Both Safari targets must have the same valid build number')
  const resources = join(extension, 'Contents/Resources')
  const manifest = JSON.parse(
    readFileSync(join(resources, 'manifest.json'), 'utf8')
  )
  if (
    manifest.name !== 'Motrix Extension' ||
    !Array.isArray(manifest.permissions) ||
    !manifest.permissions.includes('nativeMessaging') ||
    manifest.version.split('.').at(-1) !== String(build) ||
    readFileSync(join(resources, 'native-probe.js'), 'utf8').includes(
      '/safari-verification'
    ) ||
    readFileSync(join(resources, 'popup.html'), 'utf8').includes(
      'Motrix Native Verification'
    )
  )
    throw new Error(
      'Rebuild the ordinary Safari client without the diagnostic popup'
    )
  return { build, fingerprint: fingerprintBundle(app) }
}

function main() {
  const { values } = parseArgs({
    options: {
      'source-app': { type: 'string' },
      team: { type: 'string' },
      install: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(
      'Verify a signed, sandboxed Safari client and its existing installation.\n' +
        'node scripts/safari-install.mjs --team TEAMID [--source-app PATH] [--install]\n' +
        'Only --install writes to ~/Applications. It retains the previous app and restores it if installation or registration fails.\n' +
        'Does not launch apps, change Safari permissions, or register a background service.'
    )
    return
  }
  if (process.platform !== 'darwin')
    throw new Error('Safari installation requires macOS')
  bootstrapConfiguration(values.team)
  const root = fileURLToPath(new URL('../', import.meta.url))
  const registry = {
    unregister(app) {
      run('/usr/bin/pluginkit', ['-r', extensionPath(app)])
      run(launchServices, ['-u', app], undefined, true)
    },
    register(app) {
      run(launchServices, ['-f', app])
      run('/usr/bin/pluginkit', ['-a', extensionPath(app)])
    },
  }
  const result = installSafariApp({
    source: resolve(
      values['source-app'] ??
        join(
          root,
          '.cache/safari-native/DerivedData/Build/Products/Debug',
          `${appName}.app`
        )
    ),
    destination: join(homedir(), 'Applications', `${appName}.app`),
    verify: (app) => verifySafariApp(app, values.team),
    registry,
    apply: values.install === true,
  })
  console.log(JSON.stringify(result, null, 2))
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main()
