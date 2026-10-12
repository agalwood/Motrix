// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintExtensionBuild } from '../../scripts/test-windows-store-extension-runtime.mjs'
import {
  firefoxExtensionFailure,
  firefoxUiTargetExpression,
  runFirefoxStoreExtension,
  validateFirefoxExtensionIdentity,
} from '../../scripts/test-windows-store-firefox-extension.mjs'

const source = 'file:///C:/owned/firefox/'
const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const identity = () => ({
  extensions: [
    {
      id: 'motrix-extension@motrix.app',
      isActive: true,
      isSystem: false,
      hidden: false,
      manifestVersion: 3,
      version: '0.1.14',
      temporarilyInstalled: true,
      sourceURL: source,
      policy: {
        uuid,
        extensionURL: `moz-extension://${uuid}/`,
        baseURL: source,
      },
    },
  ],
})
const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('observed Firefox temporary installation identity', () => {
  it('returns only the observed popup namespace and fixed production ID', () => {
    expect(
      validateFirefoxExtensionIdentity(identity(), source, '0.1.14')
    ).toEqual({
      popupUrl: `moz-extension://${uuid}/popup.html`,
      extensionId: 'motrix-extension@motrix.app',
    })
  })
  it.each([
    { id: 'diagnostic@motrix.invalid' },
    { isActive: false },
    { isSystem: true },
    { hidden: true },
    { manifestVersion: 2 },
    { version: '0.1.13' },
    { temporarilyInstalled: false },
    { temporarilyInstalled: 'true' },
    { sourceURL: 'file:///C:/foreign/' },
    { policy: null },
  ])(
    'rejects a foreign, inactive or differently scoped install: %j',
    (change) => {
      const value = identity()
      Object.assign(value.extensions[0], change)
      expect(() =>
        validateFirefoxExtensionIdentity(value, source, '0.1.14')
      ).toThrow('firefox-extension-identity')
    }
  )
  it.each([
    { uuid: 'seeded-or-invalid' },
    { extensionURL: 'moz-extension://foreign/' },
    { baseURL: 'file:///C:/foreign/' },
  ])('rejects mismatched policy: %j', (change) => {
    const value = identity()
    Object.assign(value.extensions[0].policy, change)
    expect(() =>
      validateFirefoxExtensionIdentity(value, source, '0.1.14')
    ).toThrow('firefox-extension-identity')
  })
  it('reports only fixed boolean identity checks before rejecting a mismatch', () => {
    const value = identity()
    value.extensions[0].sourceURL = 'file:///C:/private-profile/'
    const observations: Record<string, boolean>[] = []
    expect(() =>
      validateFirefoxExtensionIdentity(value, source, '0.1.14', (entry) =>
        observations.push(entry)
      )
    ).toThrow('firefox-extension-identity')
    expect(observations).toHaveLength(1)
    expect(observations[0]).toEqual({
      inventoryArray: true,
      uniqueIdentity: true,
      sourceInputValid: true,
      active: true,
      nonSystem: true,
      visible: true,
      manifestVersionMatches: true,
      versionMatches: true,
      temporary: true,
      sourceMatches: false,
      policyBaseMatches: true,
      policyUuidValid: true,
      policyNamespaceMatches: true,
    })
    expect(JSON.stringify(observations)).not.toContain('private-profile')
    expect(JSON.stringify(observations)).not.toContain(uuid)
  })
  it('reports malformed inventory and source without leaking or throwing a URL error', () => {
    const observations: Record<string, boolean>[] = []
    expect(() =>
      validateFirefoxExtensionIdentity({}, 'not-a-url', '0.1.14', (entry) =>
        observations.push(entry)
      )
    ).toThrow('firefox-extension-identity')
    expect(observations[0].inventoryArray).toBe(false)
    expect(observations[0].sourceInputValid).toBe(false)
    expect(
      Object.values(observations[0]).every((v) => typeof v === 'boolean')
    ).toBe(true)
  })
  it('rejects duplicate identities and malformed inventory', () => {
    const value = identity()
    value.extensions.push(value.extensions[0])
    expect(() =>
      validateFirefoxExtensionIdentity(value, source, '0.1.14')
    ).toThrow('firefox-extension-identity')
    expect(() =>
      validateFirefoxExtensionIdentity({ extensions: {} }, source, '0.1.14')
    ).toThrow('firefox-extension-identity')
  })
})

describe('Firefox normal popup input targeting', () => {
  function target(html: string, action: string, covered = false) {
    const dom = new JSDOM(html, { runScripts: 'outside-only' })
    try {
      const { document, HTMLElement } = dom.window
      HTMLElement.prototype.getClientRects = () =>
        [{ x: 10, y: 10, width: 40, height: 20 }] as unknown as DOMRectList
      HTMLElement.prototype.getBoundingClientRect = () =>
        ({ x: 10, y: 10, width: 40, height: 20 }) as DOMRect
      document.elementFromPoint = () =>
        covered ? document.body : document.querySelector('button, input')!
      return JSON.parse(
        dom.window.eval(firefoxUiTargetExpression(action, 16800))
      )
    } finally {
      dom.window.close()
    }
  }
  it('locates an enabled exact normal pairing action without retaining text', () => {
    expect(target('<button>Pair</button>', 'pair')).toEqual({ x: 30, y: 20 })
  })
  it.each([
    '<button disabled>Pair</button>',
    '<button>Pair again</button>',
    '<button>Pair</button><button>Pair</button>',
  ])('refuses disabled, unrelated or ambiguous actions', (html) => {
    expect(target(html, 'pair')).toBeNull()
  })
  it('refuses a covered control and a different instance port', () => {
    expect(target('<button>Pair</button>', 'pair', true)).toBeNull()
    expect(
      target(
        '<div role="dialog"><div role="listitem"><span>Port 168001</span><button>Choose</button></div></div>',
        'candidate'
      )
    ).toBeNull()
  })
  it('rejects arbitrary actions and malformed port inputs', () => {
    expect(() => firefoxUiTargetExpression('execute', 16800)).toThrow(
      'firefox-ui-target'
    )
    expect(() => firefoxUiTargetExpression('candidate', '16800;')).toThrow(
      'firefox-ui-target'
    )
  })
})

describe('Firefox production build and scope', () => {
  it('fingerprints the background-scripts build without admitting it as a Chromium worker build', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'store-firefox-build-'))
    roots.push(root)
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        action: { default_popup: 'popup.html' },
        background: { scripts: ['worker.js'] },
        permissions: ['storage', 'nativeMessaging'],
        browser_specific_settings: {
          gecko: { id: 'motrix-extension@motrix.app' },
        },
      })
    )
    expect((await fingerprintExtensionBuild(root, 'firefox')).files).toBe(1)
    await expect(fingerprintExtensionBuild(root)).rejects.toThrow(
      'extension-build-manifest'
    )
    const report = await runFirefoxStoreExtension({
      extensionDirectory: root,
      profileDirectory: root,
      sourceCommit: 'invalid',
      appPort: 16800,
      readPairingCode: () => {
        throw new Error('must not read')
      },
    })
    expect(report.failureCode).toBe('firefox-extension-preflight-failed')
    expect(report.signedPersistentInstallationVerified).toBe(false)
    expect(report.browserRestartReconnectVerified).toBe(false)
    expect((await fingerprintExtensionBuild(root, 'firefox')).files).toBe(1)
  })
  it('only reports fixed failure stages', () => {
    expect(firefoxExtensionFailure('code-entry')).toBe(
      'firefox-extension-code-entry-failed'
    )
    expect(firefoxExtensionFailure('private data')).toBe(
      'firefox-extension-operation-failed'
    )
  })
})
