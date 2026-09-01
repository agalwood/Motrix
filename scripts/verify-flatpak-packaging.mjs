#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

export const FLATPAK_BUILDER_TOOLS_COMMIT =
  '737c0085912f9f7dabf9341d4608e2a77a51a73a'
// The aria2 tag is NOT pinned here: it derives from scripts/engine.lock.json
// at check time, so the Flatpak build and the desktop bundle cannot ship
// different engines without failing check:flatpak. Only the git commit each
// tag resolves to is pinned by hand (and cross-checked against the manifest).
export const ARIA2_SOURCE = Object.freeze({
  url: 'https://github.com/motrixapp/aria2.git',
  // v1.37.0-motrix.11 — current Motrix aria2 fork release
  commit: 'ab003d49360bac776ada3e967821410f527c00a6',
})

const PNPM_SOURCE = Object.freeze({
  url: 'https://registry.npmjs.org/pnpm/-/pnpm-11.22.0.tgz',
  sha256: '57a97e6f23a3faffc03153a4ef8c770a0552612b8640aebe39bfdd5754d0ebdc',
})

const RUST_SOURCES = Object.freeze({
  x86_64: Object.freeze({
    url: 'https://static.rust-lang.org/dist/2026-08-20/rust-1.98.0-x86_64-unknown-linux-gnu.tar.xz',
    sha256: 'ed8ee2df70909c88cbaf87a6cfa3920dac00b537de12a6abe6906641e0f5952f',
  }),
  aarch64: Object.freeze({
    url: 'https://static.rust-lang.org/dist/2026-08-20/rust-1.98.0-aarch64-unknown-linux-gnu.tar.xz',
    sha256: 'ac9283184301aeed06ecc9f5aa4c1be7041e18a1b197b6cb6c5d162d98f566da',
  }),
})

const FLATPAK_BUILDER_ACTION_COMMIT = '401fe28a8384095fc1531b9d320b292f0ee45adb'
const FLATPAK_BUILDER_IMAGE =
  'ghcr.io/flathub-infra/flatpak-github-actions:freedesktop-25.08@sha256:e3d9fbd75c7e5ce6241fb9114f59dce2156315f5977b594ea75fc97c3d364dfa'
const FLATPAK_BROKER_COMMAND = 'motrix-native-host-broker'
const FLATPAK_COMPANION_COMMAND = 'motrix-flatpak-native-host'
const FLATPAK_COMPANION_SMOKE_ARCHIVE =
  'Motrix-Native-Host-0.0.0-ci-linux-x64.tar.gz'
const BROKER_NOT_RUNNING_FRAME_HEX =
  '4d584252010000001e0000007b226572726f72223a226d6f747269782d6e6f742d72756e6e696e67227d'
const COMPANION_PAIR_FRAME_HEX =
  '5a0000007b22616374696f6e223a227265717565737450616972222c2270726f746f636f6c56657273696f6e223a312c22706f7274223a35353830392c226e6f6e6365223a224162436445664768496a4b6c4d6e4f70517253745576227d'

const BUILTIN_SIGNATURE_DIGESTS = Object.freeze({
  'motrix.filename-template-1.1.1.moext.sig':
    '5b6bfcc74e0d923ed37c4f2340bfdc4cdac30f64191a15ce5c46ddc86590bc6d',
  'motrix.scraper-hook-1.0.0.moext.sig':
    '7403d5ec5f61819370bcf153fe955e0736109b844c1eb53f959e6ebd0790be78',
  'motrix.url-resolver-1.0.0.moext.sig':
    '716af87eb2adbb4796ed6ac600c9b14840cb8354eb9ccebfe6122615ba88c17c',
})

function invariant(condition, message) {
  if (!condition) throw new Error(`Flatpak contract: ${message}`)
}

function record(value, label) {
  invariant(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `${label} must be an object`
  )
  return value
}

function array(value, label) {
  invariant(Array.isArray(value), `${label} must be an array`)
  return value
}

function moduleByName(manifest, name) {
  const module = array(manifest.modules, 'modules').find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      candidate.name === name
  )
  return record(module, `${name} module`)
}

function objectSources(module) {
  return array(module.sources, `${module.name} sources`).filter(
    (source) => typeof source === 'object' && source !== null
  )
}

function commandText(module, field = 'build-commands') {
  return array(module[field], `${module.name} ${field}`).join('\n')
}

function sourceByUrl(sources, url, label) {
  const source = sources.find((candidate) => candidate.url === url)
  return record(source, label)
}

function registryPackages(cargoLock) {
  return [
    ...cargoLock.matchAll(
      /\[\[package\]\]\n([\s\S]*?)(?=\n\[\[package\]\]|\s*$)/g
    ),
  ]
    .map((match) => match[1])
    .filter((block) => /^source = "registry\+/m.test(block))
    .map((block) => {
      const name = /^name = "([^"]+)"/m.exec(block)?.[1]
      const version = /^version = "([^"]+)"/m.exec(block)?.[1]
      invariant(name && version, 'Cargo.lock registry package is malformed')
      return `${name}-${version}`
    })
}

export async function verifyFlatpakPackaging(root = REPO_ROOT) {
  const [
    manifestSource,
    nodeSourceText,
    cargoSourceText,
    cargoLock,
    builtinLockText,
    workflow,
    packageManifestText,
  ] = await Promise.all([
    readFile(path.join(root, 'flatpak/app.motrix.native.yml'), 'utf8'),
    readFile(path.join(root, 'flatpak/generated-sources.json'), 'utf8'),
    readFile(path.join(root, 'flatpak/cargo-sources.json'), 'utf8'),
    readFile(path.join(root, 'packages/native-host/Cargo.lock'), 'utf8'),
    readFile(path.join(root, 'scripts/builtins.lock.json'), 'utf8'),
    readFile(path.join(root, '.github/workflows/flatpak.yml'), 'utf8'),
    readFile(path.join(root, 'package.json'), 'utf8'),
  ])
  const engineLockText = await readFile(
    path.join(root, 'scripts/engine.lock.json'),
    'utf8'
  )
  const engineLock = record(JSON.parse(engineLockText), 'engine.lock.json')
  invariant(
    typeof engineLock.tag === 'string' &&
      typeof engineLock.version === 'string',
    'engine.lock.json must carry tag and version'
  )

  // Every aria2 version literal in the packaging inputs must equal the
  // engine lock's version: the manifest builds the engine from source and
  // the workflow smoke-asserts its --version output, so any spot left
  // behind after a lock bump ships (or green-lights) the previous engine.
  for (const [label, text] of [
    ['flatpak/app.motrix.native.yml', manifestSource],
    ['.github/workflows/flatpak.yml', workflow],
  ]) {
    for (const token of text.match(/\d+\.\d+\.\d+-motrix\.\d+/g) ?? []) {
      invariant(
        token === engineLock.version,
        `${label} pins aria2 ${token} but engine.lock.json ships ` +
          `${engineLock.version} — bump every packaging target together`
      )
    }
  }

  const manifest = record(yaml.load(manifestSource), 'manifest')
  const modules = array(manifest.modules, 'modules')
  invariant(
    JSON.stringify(modules.map((module) => module.name)) ===
      JSON.stringify(['c-ares', 'libssh2', 'aria2', 'motrix']),
    'module order must be c-ares -> libssh2 -> aria2 -> motrix'
  )
  invariant(
    array(manifest['sdk-extensions'], 'sdk-extensions').includes(
      'org.freedesktop.Sdk.Extension.node24'
    ),
    'Node 24 SDK extension is required'
  )
  invariant(
    !manifest['sdk-extensions'].includes(
      'org.freedesktop.Sdk.Extension.rust-stable'
    ),
    'Rust must use pinned archive sources, not the floating SDK extension'
  )
  const finishArgs = array(manifest['finish-args'], 'finish-args')
  invariant(
    finishArgs.includes('--filesystem=xdg-download') &&
      !finishArgs.includes('--filesystem=home') &&
      !finishArgs.includes('--filesystem=host'),
    'downloads must use xdg-download and portal grants, never broad home/host access'
  )
  invariant(
    !finishArgs.some(
      (argument) =>
        argument === '--socket=session-bus' ||
        argument === '--socket=system-bus' ||
        argument.startsWith('--filesystem=home') ||
        argument.startsWith('--filesystem=host') ||
        argument.includes('org.freedesktop.Flatpak') ||
        argument.includes('org.freedesktop.NativeMessagingProxy') ||
        argument.includes('flatpak-spawn')
    ),
    'native messaging must not add host escape, broad bus, or proxy permissions'
  )

  const aria2 = moduleByName(manifest, 'aria2')
  const aria2Sources = objectSources(aria2)
  const aria2Git = sourceByUrl(
    aria2Sources,
    ARIA2_SOURCE.url,
    'aria2 git source'
  )
  invariant(aria2Git.type === 'git', 'aria2 must build from git source')
  invariant(
    aria2Git.tag === engineLock.tag,
    `aria2 manifest tag ${aria2Git.tag} must match engine.lock.json ` +
      `${engineLock.tag} — the Flatpak and the desktop bundle ship ONE engine`
  )
  invariant(aria2Git.commit === ARIA2_SOURCE.commit, 'aria2 commit drifted')
  const aria2SourceText = JSON.stringify(aria2Sources)
  invariant(
    aria2SourceText.includes('autoreconf -fi'),
    'aria2 source must provide an autotools bootstrap'
  )
  const aria2Commands = commandText(aria2, 'post-install')
  for (const feature of [
    'Async DNS',
    'BitTorrent',
    'HTTPS',
    'Metalink',
    'SFTP',
    'SQLite3-Persistence',
    'WebSocket',
  ]) {
    invariant(
      aria2Commands.includes(feature),
      `aria2 feature gate is missing ${feature}`
    )
  }
  invariant(
    aria2Commands.includes('/libexec/motrix-build/aria2c'),
    'aria2 must install into the build staging path'
  )

  const motrix = moduleByName(manifest, 'motrix')
  const motrixSources = array(motrix.sources, 'motrix sources')
  invariant(
    motrixSources.includes('generated-sources.json') &&
      motrixSources.includes('cargo-sources.json'),
    'both generated dependency manifests must be included'
  )
  const pnpmSource = sourceByUrl(
    objectSources(motrix),
    PNPM_SOURCE.url,
    'pnpm source'
  )
  invariant(pnpmSource.sha256 === PNPM_SOURCE.sha256, 'pnpm digest drifted')
  for (const [arch, expected] of Object.entries(RUST_SOURCES)) {
    const rustSource = sourceByUrl(
      objectSources(motrix),
      expected.url,
      `${arch} Rust source`
    )
    invariant(rustSource.type === 'archive', `${arch} Rust must be an archive`)
    invariant(rustSource.dest === 'flatpak-rust', `${arch} Rust dest drifted`)
    invariant(
      JSON.stringify(rustSource['only-arches']) === JSON.stringify([arch]),
      `${arch} Rust source architecture drifted`
    )
    invariant(
      rustSource.sha256 === expected.sha256,
      `${arch} Rust digest drifted`
    )
  }

  const motrixCommands = commandText(motrix)
  const motrixBuildOptions = JSON.stringify(
    record(motrix['build-options'], 'motrix build-options')
  )
  invariant(
    motrixCommands.includes(
      'npm install -g --prefix=/run/build/motrix/flatpak-node/pnpm-cli'
    ) &&
      motrixBuildOptions.includes(
        '/run/build/motrix/flatpak-node/pnpm-cli/bin'
      ),
    'pnpm CLI must install into a writable build prefix'
  )
  invariant(
    motrixCommands.includes('./flatpak-rust/install.sh') &&
      motrixCommands.includes(
        '--prefix=/run/build/motrix/flatpak-rust-toolchain'
      ) &&
      motrixBuildOptions.includes(
        '/run/build/motrix/flatpak-rust-toolchain/bin'
      ) &&
      !motrixBuildOptions.includes('/usr/lib/sdk/rust-stable'),
    'Rust must install from the pinned archive into a writable build prefix'
  )
  const aria2Copy = motrixCommands.indexOf(
    'extra/linux/$npm_config_target_arch/aria2c'
  )
  const nativeHostCopy = motrixCommands.indexOf(
    'packages/native-host/dist/linux-$npm_config_target_arch/motrix-native-host'
  )
  const brokerBinary = motrixCommands.indexOf(
    '/release/motrix-native-host-broker'
  )
  const electronBuild = motrixCommands.indexOf('run build:electron')
  const electronStage = motrixCommands.indexOf('run stage:electron')
  const electronBuilder = motrixCommands.indexOf('electron-builder')
  const electronPackageVerification = motrixCommands.indexOf(
    'verify-electron-package.mjs'
  )
  invariant(
    aria2Copy >= 0 && aria2Copy < electronBuilder,
    'aria2 must be staged before electron-builder'
  )
  invariant(
    nativeHostCopy >= 0 && nativeHostCopy < electronBuilder,
    'browser-facing native host must be staged transiently before electron-builder'
  )
  invariant(
    electronBuild >= 0 &&
      electronStage > electronBuild &&
      electronBuilder > electronStage &&
      electronPackageVerification > electronBuilder &&
      motrixCommands.includes('--platform linux') &&
      motrixCommands.includes('--arch $npm_config_target_arch') &&
      motrixCommands.includes('--app-dir "$unpacked"') &&
      motrixCommands.includes(
        '--report "release/size-reports/linux-$npm_config_target_arch.json"'
      ),
    'offline Flatpak build must stage and verify the explicit Electron target'
  )
  invariant(
    brokerBinary >= 0 &&
      motrixCommands.includes(
        `$FLATPAK_DEST/libexec/${FLATPAK_BROKER_COMMAND}`
      ) &&
      motrixCommands.includes(`$FLATPAK_DEST/bin/${FLATPAK_BROKER_COMMAND}`),
    'Flatpak must export the private broker command'
  )
  invariant(
    !/\$FLATPAK_DEST\/(?:bin|libexec)\/motrix-native-host(?:\s|$)/m.test(
      motrixCommands
    ),
    'Flatpak must not export a browser-facing native host'
  )
  const stripBrowserHost = motrixCommands.indexOf(
    'rm "$unpacked/resources/bin/motrix-native-host"'
  )
  const copyUnpackedApp = motrixCommands.indexOf(
    'cp -a "$unpacked" "$FLATPAK_DEST/motrix"'
  )
  invariant(
    stripBrowserHost >= 0 &&
      copyUnpackedApp > stripBrowserHost &&
      motrixCommands.includes(
        'test ! -e "$unpacked/resources/bin/motrix-native-host"'
      ),
    'browser-facing host must be removed before copying the Flatpak payload'
  )
  invariant(
    !/NativeMessagingHosts|native-messaging-hosts|\.mozilla\/native-messaging/i.test(
      motrixCommands
    ),
    'the Flatpak build must not install host browser manifests'
  )
  invariant(
    motrixCommands.includes('--bins') &&
      motrixCommands.includes('--target=$MOTRIX_RUST_TARGET') &&
      motrixBuildOptions.includes('x86_64-unknown-linux-gnu') &&
      motrixBuildOptions.includes('aarch64-unknown-linux-gnu'),
    'native-host binaries must use the Flatpak SDK GNU target'
  )
  invariant(
    !/(?:^|\n)- pnpm run build(?:\s|$)/.test(motrixCommands),
    'the aggregate build script would incorrectly request musl'
  )
  invariant(
    motrixCommands.includes('run build:builtin') &&
      motrixCommands.includes('run build:electron'),
    'explicit builtin and Electron builds are required'
  )
  invariant(
    (motrixCommands.match(/pnpm --config\.verify-deps-before-run=false/g) ?? [])
      .length === 6,
    'every pnpm run/exec after --ignore-scripts must disable dependency repair'
  )
  const flatpakScripts = new Map(
    objectSources(motrix)
      .filter((source) => source.type === 'script')
      .map((source) => [
        source['dest-filename'],
        array(source.commands, `${source['dest-filename']} commands`).join(
          '\n'
        ),
      ])
  )
  const startWrapper = flatpakScripts.get('start-motrix.sh') ?? ''
  const brokerWrapper =
    flatpakScripts.get('native-host-broker-flatpak.sh') ?? ''
  const flatpakBridgeExport =
    /MOTRIX_BRIDGE_DATA_DIR="\$\{XDG_CONFIG_HOME:\?\}\/motrix\/bridge"/
  invariant(
    flatpakBridgeExport.test(startWrapper) &&
      startWrapper.includes(
        'unset SNAP SNAP_NAME SNAP_INSTANCE_NAME SNAP_REAL_HOME'
      ) &&
      startWrapper.includes('export GTK_USE_PORTAL=1') &&
      brokerWrapper.includes(
        'unset SNAP SNAP_NAME SNAP_INSTANCE_NAME SNAP_REAL_HOME'
      ) &&
      !brokerWrapper.includes('MOTRIX_BRIDGE_DATA_DIR') &&
      brokerWrapper.includes(`exec /app/libexec/${FLATPAK_BROKER_COMMAND}`),
    'Flatpak app must publish the XDG bridge path while the broker derives it without an override'
  )

  const generatedSources = array(
    JSON.parse(nodeSourceText),
    'generated Node sources'
  )
  const generatedPnpmManifest = generatedSources.find(
    (source) => source?.['dest-filename'] === 'pnpm-manifest.json'
  )
  const generatedPnpmState = record(
    JSON.parse(String(generatedPnpmManifest?.contents ?? 'null')),
    'generated pnpm manifest'
  )
  invariant(
    generatedPnpmState.store_version === 'v11',
    'generated pnpm store must use v11'
  )
  invariant(
    !generatedSources.some((source) =>
      String(source?.dest).startsWith('flatpak-node/cache/ms-playwright/')
    ),
    'unused Playwright browser payloads must be removed'
  )
  // Derive the expected Electron version from package.json instead of
  // hardcoding it, so an Electron bump only has to regenerate the sources.
  const packageManifest = record(
    JSON.parse(packageManifestText),
    'package.json'
  )
  const electronVersion =
    packageManifest.devDependencies?.electron ??
    packageManifest.dependencies?.electron
  invariant(
    typeof electronVersion === 'string' &&
      /^\d+\.\d+\.\d+$/.test(electronVersion),
    'package.json must pin an exact electron version'
  )
  for (const [flatpakArch, electronArch] of [
    ['x86_64', 'x64'],
    ['aarch64', 'arm64'],
  ]) {
    const suffix = `electron-v${electronVersion}-linux-${electronArch}.zip`
    const source = generatedSources.find((candidate) =>
      String(candidate?.url).endsWith(suffix)
    )
    invariant(source?.sha256, `Electron ${electronArch} source is missing`)
    invariant(
      JSON.stringify(source['only-arches']) === JSON.stringify([flatpakArch]),
      `Electron ${electronArch} arch filter is wrong`
    )
  }
  invariant(
    generatedSources.some(
      (source) =>
        String(source?.url).endsWith(
          `node-v${electronVersion}-headers.tar.gz`
        ) && typeof source.sha256 === 'string'
    ),
    `Electron ${electronVersion} headers are missing`
  )

  const cargoSources = array(
    JSON.parse(cargoSourceText),
    'generated Cargo sources'
  )
  const cargoDestinations = new Set(
    cargoSources
      .map((source) => source?.dest)
      .filter((dest) => typeof dest === 'string')
  )
  for (const packageName of registryPackages(cargoLock)) {
    invariant(
      cargoDestinations.has(`cargo/vendor/${packageName}`),
      `Cargo source missing ${packageName}`
    )
  }
  invariant(
    cargoSources.some(
      (source) =>
        source?.dest === 'cargo' &&
        source?.['dest-filename'] === 'config' &&
        String(source?.contents).includes('replace-with = "vendored-sources"')
    ),
    'Cargo vendor config is missing'
  )

  const builtinLock = record(JSON.parse(builtinLockText), 'builtin lock')
  const builtinSources = objectSources(motrix).filter(
    (source) => source.dest === 'flatpak-builtins'
  )
  for (const plugin of Object.values(record(builtinLock.plugins, 'plugins'))) {
    const entry = record(plugin, 'builtin plugin')
    const artifact = builtinSources.find((source) =>
      String(source.url).endsWith(`/${entry.file}`)
    )
    invariant(
      artifact?.sha256 === entry.sha256,
      `builtin artifact source drifted: ${entry.file}`
    )
    const signatureName = `${entry.file}.sig`
    const signature = builtinSources.find((source) =>
      String(source.url).endsWith(`/${signatureName}`)
    )
    invariant(
      signature?.sha256 === BUILTIN_SIGNATURE_DIGESTS[signatureName],
      `builtin signature source drifted: ${signatureName}`
    )
  }

  invariant(
    workflow.includes(FLATPAK_BUILDER_TOOLS_COMMIT),
    'workflow must pin flatpak-builder-tools'
  )
  invariant(
    workflow.includes(FLATPAK_BUILDER_ACTION_COMMIT),
    'workflow must pin the peeled Flatpak builder action commit'
  )
  invariant(
    workflow.includes(FLATPAK_BUILDER_IMAGE) &&
      workflow.includes('options: --privileged'),
    'workflow must use the pinned privileged 25.08 builder image'
  )
  invariant(
    workflow.includes('--pnpm-store-version v11') &&
      workflow.includes('--electron-node-headers') &&
      workflow.includes('org.freedesktop.Sdk.Extension.node24//25.08'),
    'workflow generator options drifted'
  )
  invariant(
    workflow.includes('ubuntu-24.04-arm') &&
      workflow.includes('flatpak_arch: x86_64') &&
      workflow.includes('flatpak_arch: aarch64'),
    'workflow must build aarch64 on a native runner'
  )
  invariant(
    workflow.includes('cmp flatpak/generated-sources.json') &&
      workflow.includes('cmp flatpak/cargo-sources.json'),
    'workflow must compare regenerated dependency sources'
  )
  invariant(
    workflow.includes('scripts/prepare-flatpak-project.mjs') &&
      workflow.includes('flatpak/app.motrix.native.ci.yml'),
    'workflow must build the checked-out application source'
  )
  invariant(
    workflow.includes(`--command=${FLATPAK_BROKER_COMMAND}`) &&
      workflow.includes("printf 'MXBR\\001\\000\\000\\000") &&
      workflow.includes('-name "motrix-flatpak-native-host"') &&
      workflow.includes(BROKER_NOT_RUNNING_FRAME_HEX),
    'workflow must exercise the installed broker v1 private frame exactly'
  )
  invariant(
    workflow.includes('targets: x86_64-unknown-linux-musl') &&
      workflow.includes(
        'node packages/native-host/build.mjs --platform linux --arch x64'
      ) &&
      workflow.includes(
        'node packages/native-host/package-flatpak-companion.mjs'
      ) &&
      workflow.includes(FLATPAK_COMPANION_SMOKE_ARCHIVE) &&
      workflow.includes('--strip-components=1') &&
      workflow.includes(FLATPAK_COMPANION_COMMAND) &&
      workflow.includes(
        '"$archive_companion" install --flatpak-bin "$flatpak_bin"'
      ) &&
      workflow.includes('"$installed_companion" status') &&
      workflow.includes('"$installed_companion" uninstall') &&
      workflow.includes(`bridge_dir="\${XDG_CONFIG_HOME:?}/motrix/bridge"`) &&
      workflow.includes("self.path != '/discovery'") &&
      workflow.includes("self.path != '/nonce'") &&
      workflow.includes("self.headers.get('X-Motrix-Bridge') != '1'") &&
      workflow.includes(
        'chrome-extension://ibpkjhgpbidfmbmomagmldcdlpbmchgi/'
      ) &&
      workflow.includes(COMPANION_PAIR_FRAME_HEX),
    'workflow must run the x86_64 Browser Native Messaging companion smoke'
  )

  return {
    modules: modules.length,
    nodeSources: generatedSources.length,
    cargoSources: cargoSources.length,
    builtinSources: builtinSources.length,
    brokerCommand: FLATPAK_BROKER_COMMAND,
    electronPackageVerification: true,
    privateProtocolVersion: 1,
  }
}

async function main() {
  const result = await verifyFlatpakPackaging()
  process.stdout.write(
    `Flatpak contract verified: ${result.modules} modules, ` +
      `${result.nodeSources} Node sources, ${result.cargoSources} Cargo sources\n`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exitCode = 1
  }
}
