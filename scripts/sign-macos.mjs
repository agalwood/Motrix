import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const TEAM = '7VMB56CA56'
const GROUP = `${TEAM}.app.motrix.shared`
const HELPERS = {
  'Contents/MacOS/MotrixSafariRegistrar': 'app.motrix.safari.registration',
  'Contents/Library/LaunchServices/MotrixSafariBootstrap':
    'app.motrix.safari.bootstrap',
}

export function safariSignOptions(app, file, entitlements, fallback) {
  const identifier =
    HELPERS[
      path
        .relative(path.resolve(app), path.resolve(file))
        .split(path.sep)
        .join('/')
    ]
  if (!identifier) return fallback?.(file) ?? {}
  return {
    entitlements,
    hardenedRuntime: true,
    requirements: `=designated => anchor apple generic and certificate leaf[subject.OU] = "${TEAM}" and identifier "${identifier}"`,
    additionalArguments: ['--identifier', identifier],
  }
}

// Invoked only by electron-builder after identity selection. Resolve dependencies
// from its isolated, lockfile-pinned runtime, never from the unsigned app payload.
export default async function sign(options, packager) {
  const require = createRequire(
    process.env.ELECTRON_BUILDER_CLI || import.meta.url
  )
  const {
    sign: signElectron,
  } = require('app-builder-lib/out/codeSign/macCodeSign.js')
  const entitlements = path.join(
    packager.info.projectDir,
    process.env.ELECTRON_BUILDER_CLI ? 'signing-build-resources' : 'build',
    'entitlements.safari.plist'
  )
  await signElectron({
    ...options,
    optionsForFile: (file) =>
      safariSignOptions(
        options.app,
        file,
        entitlements,
        options.optionsForFile
      ),
  })
  // Check fixed identity and privileges before electron-builder submits for notarization.
  for (const [relative, identifier] of Object.entries(HELPERS)) {
    const file = path.join(options.app, relative)
    execFileSync(
      '/usr/bin/codesign',
      [
        '--verify',
        '--strict',
        '-R',
        `=anchor apple generic and certificate leaf[subject.OU] = "${TEAM}" and identifier "${identifier}" and entitlement["com.apple.security.application-groups"] = "${GROUP}"`,
        file,
      ],
      { stdio: 'pipe' }
    )
    const xml = execFileSync(
      '/usr/bin/codesign',
      ['-d', '--entitlements', '-', '--xml', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const actual = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
        input: xml,
        encoding: 'utf8',
      })
    )
    if (
      JSON.stringify(actual) !==
      JSON.stringify({ 'com.apple.security.application-groups': [GROUP] })
    ) {
      throw new Error('Safari helper has unexpected entitlements')
    }
  }
}
