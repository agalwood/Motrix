import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  safariCIBuildNumber,
  validateSafariReleaseOptions,
  verifySafariReleaseResources,
} from '../safari-release-policy.mjs'

const flags = new Set([
  '--archive',
  '--build',
  '--signed',
  '--bootstrap-client-only',
])
const env = { MOTRIX_SAFARI_RELEASE: '1' }
test('unsigned CI archives need explicit team and bounded build number', () => {
  const unsigned = new Set([...flags].filter((x) => x !== '--signed'))
  unsigned.add('--unsigned-archive')
  const ci = {
    ...env,
    MOTRIX_SAFARI_TEAM_ID: '7VMB56CA56',
    MOTRIX_SAFARI_BUILD_NUMBER: '22',
  }
  assert.doesNotThrow(() => validateSafariReleaseOptions(unsigned, ci))
  assert.throws(() =>
    validateSafariReleaseOptions(new Set([...unsigned, '--signed']), ci)
  )
  for (const team of ['', 'foo', '7VMB56CA56\n'])
    assert.throws(() =>
      validateSafariReleaseOptions(unsigned, {
        ...ci,
        MOTRIX_SAFARI_TEAM_ID: team,
      })
    )
  for (const build of ['', '0', '-1', '01', '65536', '1.0', '1\n', '$(id)'])
    assert.throws(() => safariCIBuildNumber(build))
  assert.equal(safariCIBuildNumber('65535'), 65535)
})
test('requires signed client-only release archives', () => {
  assert.doesNotThrow(() => validateSafariReleaseOptions(flags, env))
  for (const flag of ['--build', '--signed', '--bootstrap-client-only']) {
    assert.throws(() =>
      validateSafariReleaseOptions(
        new Set([...flags].filter((x) => x !== flag)),
        env
      )
    )
  }
  assert.throws(() => validateSafariReleaseOptions(flags, {}))
  assert.throws(() =>
    validateSafariReleaseOptions(
      new Set([...flags, '--bootstrap-development-host']),
      env
    )
  )
})
for (const name of [
  'MOTRIX_SAFARI_FEATURE_PROBE',
  'MOTRIX_SAFARI_VERIFY_PORT',
  'MOTRIX_DEV_PAIR_BACKOFF_MS',
]) {
  test(`rejects inherited ${name}`, () => {
    assert.throws(() =>
      validateSafariReleaseOptions(flags, { ...env, [name]: '1' })
    )
  })
}
test('rejects source maps and diagnostic code in the actual packaged resources', () => {
  const path = mkdtempSync(join(tmpdir(), 'safari-release-'))
  try {
    writeFileSync(
      join(path, 'manifest.json'),
      JSON.stringify({
        name: 'Motrix Extension',
        permissions: ['nativeMessaging'],
      })
    )
    verifySafariReleaseResources(path)
    for (const [name, body] of [
      ['test.js.map', '{}'],
      ['native-probe.js', 'safariNativeProbe'],
      ['feature.js', 'motrix.safari.featureProbe.v1'],
      ['options-preview.html', 'preview'],
    ]) {
      writeFileSync(join(path, name), body)
      assert.throws(() => verifySafariReleaseResources(path))
      rmSync(join(path, name))
    }
    writeFileSync(
      join(path, 'manifest.json'),
      JSON.stringify({ name: 'Motrix Extension', permissions: [] })
    )
    assert.throws(() => verifySafariReleaseResources(path))
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
})
