// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extensionFailure,
  fingerprintExtensionBuild,
  productionBrowserOrder,
  productionChromiumTarget,
  runStoreExtensionRuntime,
  validateProtocolDialogObservation,
} from '../../scripts/test-windows-store-extension-runtime.mjs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('protocol dialog evidence redaction', () => {
  const observation = {
    confirmed: true,
    cancelled: false,
    processIdentityVerified: true,
    ownedWindows: 1,
    openButtons: 1,
    eligibleDialogs: 1,
    namedOpenButtons: 1,
    dialogRoleAncestors: 1,
    exactTitleAncestors: 1,
    testAppTitleAncestors: 1,
    maxAncestorDepth: 5,
    ownershipBoundaries: 0,
  }
  it('keeps bounded structure and discards any raw UI text or path', () => {
    expect(
      validateProtocolDialogObservation({
        ...observation,
        title: 'private title',
        profile: 'private path',
        code: 'XXXX-XXXX',
      })
    ).toEqual(observation)
    expect(
      validateProtocolDialogObservation({
        ...observation,
        confirmed: false,
        cancelled: true,
      }).cancelled
    ).toBe(true)
  })
  it.each([
    { cancelled: true },
    { confirmed: 'true' },
    { cancelled: 'false' },
    { processIdentityVerified: false },
    { openButtons: -1 },
    { openButtons: 101 },
    { openButtons: 1.5 },
    { eligibleDialogs: 0 },
    { eligibleDialogs: 2 },
    { exactTitleAncestors: 0 },
    { dialogRoleAncestors: 0 },
    { maxAncestorDepth: 13 },
    { maxAncestorDepth: 0 },
    { ownershipBoundaries: '0' },
  ])('rejects contradictory, missing or unbounded evidence: %j', (change) => {
    expect(() =>
      validateProtocolDialogObservation({ ...observation, ...change })
    ).toThrow('protocol-confirmation-failed')
  })
  it('retains a failed search without turning it into consent', () => {
    const failed = {
      ...observation,
      confirmed: false,
      eligibleDialogs: 0,
      exactTitleAncestors: 0,
    }
    expect(validateProtocolDialogObservation(failed)).toEqual(failed)
  })
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'store-extension-test-'))
  roots.push(root)
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      action: { default_popup: 'popup.html' },
      background: { service_worker: 'worker.js' },
      permissions: ['storage', 'nativeMessaging'],
    })
  )
  await writeFile(path.join(root, 'worker.js'), 'worker-source')
  return root
}

describe('production extension build binding', () => {
  it('binds every build file, including maps and relative names', async () => {
    const root = await fixture()
    const original = await fingerprintExtensionBuild(root)
    expect(original.files).toBe(2)
    expect(original.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await fingerprintExtensionBuild(root)).toEqual(original)
    await mkdir(path.join(root, 'assets'))
    await writeFile(path.join(root, 'assets', 'source.map'), 'map')
    const withMap = await fingerprintExtensionBuild(root)
    expect(withMap.sha256).not.toBe(original.sha256)
    expect(withMap.files).toBe(3)
    await writeFile(path.join(root, 'worker.js'), 'changed-source')
    expect((await fingerprintExtensionBuild(root)).sha256).not.toBe(
      withMap.sha256
    )
  })
  it('refuses symlinks instead of incorporating outside files', async () => {
    const root = await fixture()
    await symlink(path.join(root, 'worker.js'), path.join(root, 'alias.js'))
    await expect(fingerprintExtensionBuild(root)).rejects.toThrow(
      'extension-build-link'
    )
  })
  it('rejects a fixture manifest with no production popup and worker', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'manifest.json'), '{}')
    await expect(fingerprintExtensionBuild(root)).rejects.toThrow(
      'extension-build-manifest'
    )
  })
  it('bounds input inventory', async () => {
    const root = await fixture()
    await Promise.all(
      Array.from({ length: 255 }, (_, i) =>
        writeFile(path.join(root, `${i}.js`), '')
      )
    )
    await expect(fingerprintExtensionBuild(root)).rejects.toThrow(
      'extension-build-limit'
    )
  })
})

describe('production browser evidence boundary', () => {
  it('maps only fixed stages to failure codes without exposing arbitrary text', () => {
    expect(extensionFailure('code-entry')).toBe('extension-code-entry-failed')
    expect(extensionFailure('secret code XXXX-XXXX')).toBe(
      'extension-operation-failed'
    )
  })
  it('fails closed before browser startup for malformed source provenance', async () => {
    const root = await fixture()
    const report = await runStoreExtensionRuntime({
      browserName: 'chrome',
      extensionDirectory: root,
      sourceCommit: 'invalid-commit',
      profileDirectory: root,
      appPort: 16800,
      readPairingCode: () => {
        throw new Error('must not run')
      },
    })
    expect(report.ok).toBe(false)
    expect(report.failureCode).toBe('extension-preflight-failed')
    expect(report.firstPairVerified).toBe(false)
    // Invalid inputs must not remove an existing directory.
    expect((await fingerprintExtensionBuild(root)).files).toBe(2)
  })
})

describe('production Chromium browser selection', () => {
  it('retains both brands and runs the requested application-closing case last', () => {
    expect(productionBrowserOrder('chrome')).toEqual(['edge', 'chrome'])
    expect(productionBrowserOrder('edge')).toEqual(['chrome', 'edge'])
  })
  it('selects the matching branded channel and evidence scope', () => {
    expect(productionChromiumTarget('chrome')).toEqual({
      browserName: 'chrome',
      channel: 'chrome',
      scope: 'installed-appx-production-chrome-extension',
    })
    expect(productionChromiumTarget('edge')).toEqual({
      browserName: 'edge',
      channel: 'msedge',
      scope: 'installed-appx-production-edge-extension',
    })
  })
  it.each(['firefox', 'chromium', 'edge --no-sandbox', '', undefined])(
    'rejects unsupported browser %s before launch',
    (name) => {
      expect(() => productionChromiumTarget(name)).toThrow(
        'extension-browser-unsupported'
      )
      expect(() => productionBrowserOrder(name)).toThrow(
        'extension-browser-unsupported'
      )
    }
  )
})
