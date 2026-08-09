import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILD_TARGETS,
  cargoBuildArguments,
  parseArgs,
  resolveBuildTarget,
} from './build.mjs'

test('parses split and inline target arguments', () => {
  assert.deepEqual(parseArgs(['--platform', 'linux', '--arch=arm64']), {
    platform: 'linux',
    arch: 'arm64',
  })
  assert.throws(
    () => parseArgs(['--platform', 'linux']),
    /must be provided together/
  )
  assert.throws(() => parseArgs(['--all']), /unknown flag/)
  assert.deepEqual(
    parseArgs(['--', '--platform', 'darwin', '--arch', 'arm64']),
    {
      platform: 'darwin',
      arch: 'arm64',
    }
  )
})

test('defaults to the host and supports explicit environment mapping', () => {
  assert.equal(
    resolveBuildTarget(
      { platform: undefined, arch: undefined },
      {},
      { platform: 'darwin', arch: 'arm64' }
    ).rustTarget,
    'aarch64-apple-darwin'
  )
  assert.equal(
    resolveBuildTarget(
      { platform: undefined, arch: undefined },
      {
        MOTRIX_NATIVE_HOST_PLATFORM: 'linux',
        MOTRIX_NATIVE_HOST_ARCH: 'x64',
      },
      { platform: 'darwin', arch: 'arm64' }
    ).rustTarget,
    'x86_64-unknown-linux-musl'
  )
  assert.equal(
    resolveBuildTarget(
      { platform: 'darwin', arch: 'x64' },
      {
        npm_config_arch: 'arm64',
        MOTRIX_NATIVE_HOST_PLATFORM: 'linux',
      },
      { platform: 'darwin', arch: 'arm64' }
    ).rustTarget,
    'x86_64-apple-darwin'
  )
})

test('maps every release target and reserves Windows arm64 without output', () => {
  assert.equal(
    BUILD_TARGETS.get('win32-arm64').rustTarget,
    'aarch64-pc-windows-msvc'
  )
  assert.equal(
    resolveBuildTarget(
      { platform: 'win32', arch: 'x64' },
      {},
      { platform: 'darwin', arch: 'arm64' }
    ).binaryName,
    'motrix-native-host.exe'
  )
  assert.throws(
    () =>
      resolveBuildTarget(
        { platform: 'linux', arch: 'ia32' },
        {},
        { platform: 'darwin', arch: 'arm64' }
      ),
    /unsupported native-host target/
  )
})

test('builds the Flatpak companion only for supported Linux targets', () => {
  for (const key of ['linux-x64', 'linux-arm64']) {
    assert.equal(
      BUILD_TARGETS.get(key).companionBinaryName,
      'motrix-flatpak-native-host'
    )
  }
  for (const key of [
    'darwin-arm64',
    'darwin-x64',
    'win32-x64',
    'win32-arm64',
  ]) {
    assert.equal(BUILD_TARGETS.get(key).companionBinaryName, undefined)
  }

  const linuxArguments = cargoBuildArguments(
    resolveBuildTarget(
      { platform: 'linux', arch: 'x64' },
      {},
      { platform: 'darwin', arch: 'arm64' }
    ),
    '/tmp/native-host-target'
  )
  assert.deepEqual(linuxArguments.slice(-4), [
    '--bin',
    'motrix-native-host',
    '--bin',
    'motrix-flatpak-native-host',
  ])

  const macArguments = cargoBuildArguments(
    resolveBuildTarget(
      { platform: 'darwin', arch: 'arm64' },
      {},
      { platform: 'darwin', arch: 'arm64' }
    ),
    '/tmp/native-host-target'
  )
  assert.deepEqual(macArguments.slice(-2), ['--bin', 'motrix-native-host'])
})
