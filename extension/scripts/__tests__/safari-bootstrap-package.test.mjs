import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bootstrapConfiguration,
  bootstrapLaunchAgent,
  developmentHostEntitlements,
} from '../safari-bootstrap-package.mjs'
import { safariVerificationProbe } from '../safari-verification-probe.mjs'

test('development host changes only the container sandbox entitlement', () => {
  const original = {
    'com.apple.security.app-sandbox': true,
    'com.apple.security.application-groups': ['TESTTEAM01.app.motrix.shared'],
    'com.apple.security.get-task-allow': true,
  }
  assert.deepEqual(developmentHostEntitlements(original), {
    'com.apple.security.application-groups': ['TESTTEAM01.app.motrix.shared'],
    'com.apple.security.get-task-allow': true,
  })
  assert.equal(original['com.apple.security.app-sandbox'], true)
})

test('verification probes can target only a literal IPv4 loopback port', () => {
  assert.match(
    safariVerificationProbe('16802'),
    /ws:\/\/127\.0\.0\.1:16802\/safari-verification/
  )
  for (const port of [
    '',
    undefined,
    '0',
    '65536',
    '123;alert(1)',
    'https://example.com',
    '123/other',
  ]) {
    assert.throws(() => safariVerificationProbe(port))
  }
})

test('bootstrap packaging rejects missing or injected signing teams', () => {
  for (const team of [
    undefined,
    '',
    '-',
    'ABCDE',
    'AAAAAAAAAA" or true',
    'abcdefghij',
  ]) {
    assert.throws(() => bootstrapConfiguration(team))
  }
})

test('launch agent exposes only the group-scoped service and a bundle-relative helper', () => {
  const configuration = bootstrapConfiguration('TESTTEAM01')
  const agent = bootstrapLaunchAgent(configuration)
  assert.equal(
    configuration.ClientBundleIdentifier,
    'app.motrix.safari.extension'
  )
  assert.equal(configuration.ServiceBundleIdentifier, agent.Label)
  assert.deepEqual(agent.MachServices, {
    'TESTTEAM01.app.motrix.shared.bootstrap': true,
  })
  assert.equal(
    agent.BundleProgram,
    'Contents/Library/LaunchServices/MotrixSafariBootstrap'
  )
  assert.equal(agent.ProgramArguments, undefined)
  assert.equal(agent.KeepAlive, undefined)
})
