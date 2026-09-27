import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import {
  renderWindowsStoreManifest,
  renderWindowsStorePriConfig,
  WINDOWS_STORE_CURRENT_ASSETS_STORE_READY,
  WINDOWS_STORE_SCALE_200_ASSETS,
} from '../../scripts/windows-store-manifest.mjs'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import {
  WINDOWS_STORE_NATIVE_MESSAGING_DIAGNOSTIC,
  WINDOWS_STORE_TEST_IDENTITY,
} from '../../scripts/windows-store-metadata.mjs'
import windowsPackage from '../../src/shared/config/windows-package.json'

const FOUNDATION =
  'http://schemas.microsoft.com/appx/manifest/foundation/windows10'
const UAP = 'http://schemas.microsoft.com/appx/manifest/uap/windows10'
const UAP3 = `${UAP}/3`
const UAP5 = `${UAP}/5`
const UAP10 = `${UAP}/10`
const DESKTOP = 'http://schemas.microsoft.com/appx/manifest/desktop/windows10'
const DESKTOP4 = `${DESKTOP}/4`
const COM = 'http://schemas.microsoft.com/appx/manifest/com/windows10'
const RESCAP = `${FOUNDATION}/restrictedcapabilities`

function storeMetadata(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    profile: 'store',
    architecture: 'x64',
    productVersion: '2.3.4',
    packageVersion: '7.10.2.0',
    source: { commit: 'a'.repeat(40), tag: 'v2.3.4' },
    // An external unit-test fixture, never a production identity fallback.
    identity: {
      name: 'Example.ManifestFixture',
      publisher: 'CN=Manifest Fixture, O=Example',
      publisherDisplayName: 'Manifest Fixture',
    },
    ...overrides,
  }
}

function testMetadata(overrides: Record<string, unknown> = {}) {
  return storeMetadata({
    profile: 'test',
    productVersion: '2.3.4-beta.41',
    packageVersion: '1.0.1.0',
    source: { commit: 'b'.repeat(40) },
    identity: { ...WINDOWS_STORE_TEST_IDENTITY },
    ...overrides,
  })
}

function parseXml(xml: string) {
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  expect(document.getElementsByTagName('parsererror')).toHaveLength(0)
  expect(document.doctype).toBeNull()
  return document
}

function element(document: Document, namespace: string, name: string) {
  const matches = document.getElementsByTagNameNS(namespace, name)
  expect(matches).toHaveLength(1)
  return matches[0]
}

function attributes(element: Element) {
  return Object.fromEntries(
    Array.from(element.attributes, ({ name, value }) => [name, value])
  )
}

describe('Windows Store manifest renderer', () => {
  it.each([
    [
      'store',
      storeMetadata(),
      'bfd8b921a83a40e6f481457dc40b85b81b061557d77eddc7941030947d62abcc',
    ],
    [
      'test',
      testMetadata(),
      '35827725efba807e2b8577141e67f732ddd4bb253135003aaaac453826bc8360',
    ],
  ])(
    'keeps the ordinary %s manifest byte-identical to the pre-diagnostic contract',
    (_profile, input, expected) => {
      expect(
        createHash('sha256')
          .update(renderWindowsStoreManifest(input))
          .digest('hex')
      ).toBe(expected)
    }
  )

  it('preserves the exact identity and independent package version', () => {
    const input = storeMetadata()
    const document = parseXml(renderWindowsStoreManifest(input))
    const root = document.documentElement

    expect(root.localName).toBe('Package')
    expect(root.namespaceURI).toBe(FOUNDATION)
    expect(root.lookupNamespaceURI('uap')).toBe(UAP)
    expect(root.lookupNamespaceURI('uap3')).toBe(UAP3)
    expect(root.lookupNamespaceURI('uap10')).toBe(UAP10)
    expect(root.lookupNamespaceURI('desktop')).toBe(DESKTOP)
    expect(root.lookupNamespaceURI('com')).toBe(COM)
    expect(root.lookupNamespaceURI('rescap')).toBe(RESCAP)
    expect(root.getAttribute('IgnorableNamespaces')).toBe(
      'uap uap3 uap10 desktop com rescap'
    )
    expect(attributes(element(document, FOUNDATION, 'Identity'))).toEqual({
      Name: input.identity.name,
      Publisher: input.identity.publisher,
      Version: input.packageVersion,
      ProcessorArchitecture: 'x64',
    })
    expect(
      element(document, FOUNDATION, 'PublisherDisplayName').textContent
    ).toBe(input.identity.publisherDisplayName)
    expect(element(document, FOUNDATION, 'DisplayName').textContent).toBe(
      'Motrix'
    )
  })

  it('declares only the main medium-IL desktop application and runFullTrust', () => {
    const xml = renderWindowsStoreManifest(storeMetadata())
    const document = parseXml(xml)
    const application = element(document, FOUNDATION, 'Application')

    expect(attributes(application)).toEqual({
      Id: 'Motrix',
      Executable: 'app\\Motrix.exe',
      'uap10:RuntimeBehavior': 'packagedClassicApp',
      'uap10:TrustLevel': 'mediumIL',
    })
    expect(application.getAttributeNS(UAP10, 'RuntimeBehavior')).toBe(
      'packagedClassicApp'
    )
    expect(application.getAttributeNS(UAP10, 'TrustLevel')).toBe('mediumIL')
    expect(attributes(element(document, RESCAP, 'Capability'))).toEqual({
      Name: 'runFullTrust',
    })
    // The entire element inventory prevents unnoticed extra capabilities,
    // extension namespaces, helper Applications, or installer declarations.
    expect(
      Array.from(document.getElementsByTagName('*'), (node) => [
        node.namespaceURI,
        node.localName,
      ])
    ).toEqual([
      [FOUNDATION, 'Package'],
      [FOUNDATION, 'Identity'],
      [FOUNDATION, 'Properties'],
      [FOUNDATION, 'DisplayName'],
      [FOUNDATION, 'PublisherDisplayName'],
      [FOUNDATION, 'Description'],
      [FOUNDATION, 'Logo'],
      [FOUNDATION, 'Resources'],
      [FOUNDATION, 'Resource'],
      [FOUNDATION, 'Dependencies'],
      [FOUNDATION, 'TargetDeviceFamily'],
      [FOUNDATION, 'Capabilities'],
      [RESCAP, 'Capability'],
      [FOUNDATION, 'Applications'],
      [FOUNDATION, 'Application'],
      [UAP, 'VisualElements'],
      [UAP, 'DefaultTile'],
      [FOUNDATION, 'Extensions'],
      [UAP3, 'Extension'],
      [UAP3, 'Protocol'],
      [UAP3, 'Extension'],
      [UAP3, 'Protocol'],
      [UAP3, 'Extension'],
      [UAP3, 'Protocol'],
      [UAP3, 'Extension'],
      [UAP3, 'FileTypeAssociation'],
      [UAP, 'SupportedFileTypes'],
      [UAP, 'FileType'],
      [DESKTOP, 'Extension'],
      [DESKTOP, 'StartupTask'],
      [DESKTOP, 'Extension'],
      [DESKTOP, 'ToastNotificationActivation'],
      [COM, 'Extension'],
      [COM, 'ComServer'],
      [COM, 'ExeServer'],
      [COM, 'Class'],
    ])
    expect(xml).not.toMatch(/EntryPoint|AppExecutionAlias|\$\{|@@/)
  })

  it('passes each declared protocol as one quoted argument to the desktop executable', () => {
    const document = parseXml(renderWindowsStoreManifest(testMetadata()))
    const protocols = Array.from(
      document.getElementsByTagNameNS(UAP3, 'Protocol')
    )
    expect(protocols.map(attributes)).toEqual(
      ['motrix', 'mo', 'magnet'].map((Name) => ({
        Name,
        Parameters: '"%1"',
      }))
    )
    for (const protocol of protocols) {
      expect(protocol.children).toHaveLength(0)
      expect(attributes(protocol.parentElement!)).toEqual({
        Category: 'windows.protocol',
        Executable: 'app\\Motrix.exe',
        'uap10:RuntimeBehavior': 'packagedClassicApp',
        'uap10:TrustLevel': 'mediumIL',
      })
    }
  })

  it('declares only the torrent file type and passes its path as one quoted argument', () => {
    const xml = renderWindowsStoreManifest(testMetadata())
    const document = parseXml(xml)
    const association = element(document, UAP3, 'FileTypeAssociation')
    expect(attributes(association)).toEqual({
      Name: 'torrent',
      Parameters: '"%1"',
      MultiSelectModel: 'Document',
    })
    expect(attributes(association.parentElement!)).toEqual({
      Category: 'windows.fileTypeAssociation',
      Executable: 'app\\Motrix.exe',
      'uap10:RuntimeBehavior': 'packagedClassicApp',
      'uap10:TrustLevel': 'mediumIL',
    })
    const supportedTypes = element(document, UAP, 'SupportedFileTypes')
    expect(supportedTypes.parentElement).toBe(association)
    expect(attributes(supportedTypes)).toEqual({})
    const fileType = element(document, UAP, 'FileType')
    expect(fileType.parentElement).toBe(supportedTypes)
    expect(attributes(fileType)).toEqual({})
    expect(fileType.textContent).toBe('.torrent')
    expect(xml).not.toMatch(
      /MigrationProgId|UserChoice|AllowSilentDefaultTakeOver|UseUrl|SupportedVerbs/
    )
  })

  it('starts the package executable only after opt-in with the login argument', () => {
    const document = parseXml(renderWindowsStoreManifest(testMetadata()))
    const startupTask = element(document, DESKTOP, 'StartupTask')
    expect(attributes(startupTask.parentElement!)).toEqual({
      Category: 'windows.startupTask',
      Executable: 'app\\Motrix.exe',
      'uap10:RuntimeBehavior': 'packagedClassicApp',
      'uap10:TrustLevel': 'mediumIL',
      'uap10:Parameters': '--opened-at-login=1',
    })
    expect(attributes(startupTask)).toEqual({
      TaskId: 'MotrixStartup',
      Enabled: 'false',
      DisplayName: 'Motrix Store TEST ONLY',
    })
  })

  it.each([
    ['test', testMetadata(), 'Motrix Store TEST ONLY'],
    ['store', storeMetadata(), 'Motrix'],
  ])(
    'registers the shared toast activator and its COM server for the %s profile',
    (_profile, input, displayName) => {
      const document = parseXml(renderWindowsStoreManifest(input))
      const extensions = element(document, FOUNDATION, 'Extensions')
      expect(extensions.parentElement).toBe(
        element(document, FOUNDATION, 'Application')
      )
      expect(windowsPackage.toastActivatorClsid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      )

      const toast = element(document, DESKTOP, 'ToastNotificationActivation')
      expect(attributes(toast)).toEqual({
        ToastActivatorCLSID: windowsPackage.toastActivatorClsid,
      })
      expect(toast.children).toHaveLength(0)
      const toastExtension = toast.parentElement!
      expect(toastExtension.namespaceURI).toBe(DESKTOP)
      expect(toastExtension.localName).toBe('Extension')
      expect(attributes(toastExtension)).toEqual({
        Category: 'windows.toastNotificationActivation',
      })
      expect(toastExtension.parentElement).toBe(extensions)

      const comExtension = element(document, COM, 'Extension')
      expect(attributes(comExtension)).toEqual({
        Category: 'windows.comServer',
      })
      expect(comExtension.parentElement).toBe(extensions)
      const server = element(document, COM, 'ComServer')
      expect(server.parentElement).toBe(comExtension)
      expect(attributes(server)).toEqual({})
      const executable = element(document, COM, 'ExeServer')
      expect(executable.parentElement).toBe(server)
      expect(attributes(executable)).toEqual({
        Executable: 'app\\Motrix.exe',
        DisplayName: displayName,
      })
      const activator = element(document, COM, 'Class')
      expect(activator.parentElement).toBe(executable)
      expect(attributes(activator)).toEqual({
        Id: windowsPackage.toastActivatorClsid,
      })
      expect(activator.children).toHaveLength(0)
    }
  )

  it('declares one language, configured OS thresholds, and logical asset paths', () => {
    const document = parseXml(renderWindowsStoreManifest(storeMetadata()))
    expect(attributes(element(document, FOUNDATION, 'Resource'))).toEqual({
      Language: 'en-US',
    })
    expect(
      attributes(element(document, FOUNDATION, 'TargetDeviceFamily'))
    ).toEqual({
      Name: 'Windows.Desktop',
      MinVersion: '10.0.19045.0',
      MaxVersionTested: '10.0.19045.0',
    })
    expect(element(document, FOUNDATION, 'Logo').textContent).toBe(
      'Assets\\StoreLogo.png'
    )
    const visual = element(document, UAP, 'VisualElements')
    expect(visual.getAttribute('Square44x44Logo')).toBe(
      'Assets\\Square44x44Logo.png'
    )
    expect(visual.getAttribute('Square150x150Logo')).toBe(
      'Assets\\Square150x150Logo.png'
    )
    expect(
      element(document, UAP, 'DefaultTile').getAttribute('Wide310x150Logo')
    ).toBe('Assets\\Wide310x150Logo.png')
  })

  it('makes experimental names conspicuous while retaining the fixed test identity', () => {
    const input = testMetadata()
    const document = parseXml(renderWindowsStoreManifest(input))
    expect(attributes(element(document, FOUNDATION, 'Identity'))).toEqual({
      Name: WINDOWS_STORE_TEST_IDENTITY.name,
      Publisher: WINDOWS_STORE_TEST_IDENTITY.publisher,
      Version: input.packageVersion,
      ProcessorArchitecture: 'x64',
    })
    const displayName = element(document, FOUNDATION, 'DisplayName').textContent
    expect(displayName).toBe('Motrix Store TEST ONLY')
    expect(
      element(document, UAP, 'VisualElements').getAttribute('DisplayName')
    ).toBe(displayName)
    expect(element(document, FOUNDATION, 'Description').textContent).toContain(
      'not for distribution'
    )
  })

  it('round-trips untrusted XML punctuation as identity text without injected markup', () => {
    const identity = {
      name: 'Example.Exact-Identity',
      publisher: 'CN="Fixture & Co" /><Injected attr="x"> \'quoted\' &amp;',
      publisherDisplayName: '测试 & <Publisher> "Company" \'Name\' &amp;',
    }
    const xml = renderWindowsStoreManifest(storeMetadata({ identity }))
    const document = parseXml(xml)
    expect(
      element(document, FOUNDATION, 'Identity').getAttribute('Publisher')
    ).toBe(identity.publisher)
    expect(
      element(document, FOUNDATION, 'PublisherDisplayName').textContent
    ).toBe(identity.publisherDisplayName)
    expect(document.getElementsByTagName('Injected')).toHaveLength(0)
    expect(document.getElementsByTagName('Publisher')).toHaveLength(0)
    expect(xml).toContain('&amp;amp;')
    expect(xml).toContain('&quot;')
    expect(xml).toContain('&apos;')
    expect(xml).toContain('&lt;')
    expect(xml).toContain('&gt;')
  })
})

describe('test Native Messaging diagnostic manifest', () => {
  const diagnostic = WINDOWS_STORE_NATIVE_MESSAGING_DIAGNOSTIC
  const input = () => testMetadata({ testDiagnostics: diagnostic.mode })

  it('declares exactly the fixed hidden console helper and alias alongside the unchanged main app', () => {
    const document = parseXml(renderWindowsStoreManifest(input()))
    const root = document.documentElement
    expect(root.lookupNamespaceURI('uap5')).toBe(UAP5)
    expect(root.lookupNamespaceURI('desktop4')).toBe(DESKTOP4)
    expect(root.getAttribute('IgnorableNamespaces')).toBe(
      'uap uap3 uap10 desktop com rescap uap5 desktop4'
    )
    const applications = Array.from(
      document.getElementsByTagNameNS(FOUNDATION, 'Application')
    )
    expect(applications.map((app) => app.getAttribute('Id'))).toEqual([
      'Motrix',
      diagnostic.applicationId,
    ])
    expect(applications[0].outerHTML).toBe(
      element(
        parseXml(renderWindowsStoreManifest(testMetadata())),
        FOUNDATION,
        'Application'
      ).outerHTML
    )
    const helper = applications[1]
    const executable = diagnostic.executable.replaceAll('/', '\\')
    expect(attributes(helper)).toEqual({
      Id: diagnostic.applicationId,
      Executable: executable,
      'uap10:RuntimeBehavior': 'packagedClassicApp',
      'uap10:TrustLevel': 'mediumIL',
      'desktop4:Subsystem': 'console',
      'desktop4:SupportsMultipleInstances': 'true',
    })
    expect(
      Array.from(helper.children, (node) => [node.namespaceURI, node.localName])
    ).toEqual([
      [UAP, 'VisualElements'],
      [FOUNDATION, 'Extensions'],
    ])
    const visuals = helper.getElementsByTagNameNS(UAP, 'VisualElements')
    expect(visuals).toHaveLength(1)
    expect(attributes(visuals[0])).toEqual({
      DisplayName: 'Motrix Native Messaging PROBE',
      Description: 'Test-only Native Messaging diagnostic',
      AppListEntry: 'none',
      BackgroundColor: 'transparent',
      Square150x150Logo: 'Assets\\Square150x150Logo.png',
      Square44x44Logo: 'Assets\\Square44x44Logo.png',
    })
    expect(visuals[0].children).toHaveLength(0)
    const extensions = helper.getElementsByTagNameNS(FOUNDATION, 'Extensions')
    expect(extensions).toHaveLength(1)
    expect(extensions[0].children).toHaveLength(1)
    const extension = element(document, UAP5, 'Extension')
    expect(extension.parentElement).toBe(extensions[0])
    expect(attributes(extension)).toEqual({
      Category: 'windows.appExecutionAlias',
      Executable: executable,
      'uap10:RuntimeBehavior': 'packagedClassicApp',
      'uap10:TrustLevel': 'mediumIL',
    })
    expect(extension.children).toHaveLength(1)
    const aliases = element(document, UAP5, 'AppExecutionAlias')
    expect(aliases.parentElement).toBe(extension)
    expect(attributes(aliases)).toEqual({ 'desktop4:Subsystem': 'console' })
    expect(aliases.children).toHaveLength(1)
    const alias = element(document, UAP5, 'ExecutionAlias')
    expect(alias.parentElement).toBe(aliases)
    expect(attributes(alias)).toEqual({ Alias: diagnostic.alias })
    expect(alias.children).toHaveLength(0)
    expect(attributes(element(document, RESCAP, 'Capability'))).toEqual({
      Name: 'runFullTrust',
    })
    expect(renderWindowsStoreManifest(input())).not.toMatch(
      /EntryPoint|unvirtualizedResources|motrix-native-host\.exe/
    )
  })

  it('keeps all four existing logical image resources and the same PRI config', () => {
    const document = parseXml(renderWindowsStoreManifest(input()))
    const images = new Set([element(document, FOUNDATION, 'Logo').textContent])
    for (const node of Array.from(document.getElementsByTagName('*'))) {
      for (const attribute of Array.from(node.attributes)) {
        if (attribute.name.endsWith('Logo')) images.add(attribute.value)
      }
    }
    expect([...images].sort()).toEqual(
      WINDOWS_STORE_SCALE_200_ASSETS.map((asset: { logicalPath: string }) =>
        asset.logicalPath.replaceAll('/', '\\')
      ).sort()
    )
    expect(renderWindowsStorePriConfig(input())).toBe(
      renderWindowsStorePriConfig(testMetadata())
    )
  })

  it('changes only the package version during the A to B diagnostic upgrade', () => {
    const a = input()
    const b = {
      ...a,
      packageVersion: '1.0.2.0',
      previousPackageVersions: [a.packageVersion],
    }
    expect(renderWindowsStoreManifest(b)).toBe(
      renderWindowsStoreManifest(a).replace(
        'Version="1.0.1.0"',
        'Version="1.0.2.0"'
      )
    )
  })

  it('binds the probe source to the current fixed package name while retaining the P0 helper', async () => {
    const source = await readFile(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../..',
        diagnostic.source
      ),
      'utf8'
    )
    expect(source).toContain(
      `${WINDOWS_STORE_TEST_IDENTITY.name.replaceAll('.', String.raw`\\.`)}_`
    )
    expect(source).toContain(`!${diagnostic.applicationId}`)
    expect(source).toContain('motrix-store-p0')
  })

  it.each([undefined, null, 'unknown', { mode: diagnostic.mode }])(
    'rejects malformed test diagnostic modes before rendering: %#',
    (testDiagnostics) => {
      expect(() =>
        renderWindowsStoreManifest(testMetadata({ testDiagnostics }))
      ).toThrow(/testDiagnostics/)
    }
  )

  it.each([undefined, diagnostic.mode])(
    'never emits diagnostic declarations for Store metadata: %#',
    (testDiagnostics) => {
      expect(() =>
        renderWindowsStoreManifest(storeMetadata({ testDiagnostics }))
      ).toThrow(/only allowed for the test profile/)
    }
  )
})

describe('Windows Store PRI config renderer', () => {
  it.each([
    ['test', testMetadata(), '200'],
    ['store', storeMetadata(), '100'],
  ])(
    'indexes the isolated %s asset root with the intended fallback scale',
    (_profile, input, scale) => {
      const xml = renderWindowsStorePriConfig(input)
      const document = parseXml(xml)
      const root = document.documentElement
      expect(root.localName).toBe('resources')
      expect(root.namespaceURI).toBeNull()
      expect(attributes(root)).toEqual({
        targetOsVersion: '10.0.0',
        majorVersion: '1',
      })
      const index = document.getElementsByTagName('index')
      expect(index).toHaveLength(1)
      expect(attributes(index[0])).toEqual({
        root: '\\',
        startIndexAt: '\\',
      })
      expect(
        Array.from(document.getElementsByTagName('qualifier'), attributes)
      ).toEqual([
        { name: 'Language', value: 'en-US' },
        { name: 'Scale', value: scale },
      ])
      const indexers = document.getElementsByTagName('indexer-config')
      expect(indexers).toHaveLength(1)
      expect(attributes(indexers[0])).toEqual({
        type: 'folder',
        foldernameAsQualifier: 'true',
        filenameAsQualifier: 'true',
        qualifierDelimiter: '.',
      })
      expect(
        Array.from(document.getElementsByTagName('*'), (node) => node.localName)
      ).toEqual([
        'resources',
        'index',
        'default',
        'qualifier',
        'qualifier',
        'indexer-config',
      ])
      expect(xml).not.toMatch(/packaging|autoResourcePackage|\$\{|@@/)
    }
  )
})

describe.each([
  ['manifest', renderWindowsStoreManifest],
  ['PRI', renderWindowsStorePriConfig],
])('%s renderer input boundary', (_name, render) => {
  it.each([
    [
      'mismatched source tag',
      { source: { commit: 'a'.repeat(40), tag: 'v2.3.5' } },
    ],
    ['unsupported architecture', { architecture: 'arm64' }],
    ['caller-supplied extension', { extensions: ['windows.protocol'] }],
    ['invalid package revision', { packageVersion: '7.10.2.1' }],
    ['reused test identity', { identity: { ...WINDOWS_STORE_TEST_IDENTITY } }],
    [
      'control character',
      {
        identity: {
          ...storeMetadata().identity,
          publisherDisplayName: 'Fixture\u0000Name',
        },
      },
    ],
  ])('rejects %s before rendering', (_reason, overrides) => {
    expect(() => render(storeMetadata(overrides))).toThrow()
  })

  it('is deterministic and does not mutate or freeze caller metadata', () => {
    const input = storeMetadata({ previousPackageVersions: ['7.10.1.9'] })
    const before = structuredClone(input)
    const output = render(input)
    expect(render(input)).toBe(output)
    expect(input).toEqual(before)
    expect(Object.isFrozen(input)).toBe(false)
  })
})

describe('current Windows Store asset inventory', () => {
  it('exposes an immutable test asset contract without claiming production readiness', () => {
    expect(WINDOWS_STORE_CURRENT_ASSETS_STORE_READY).toBe(false)
    expect(WINDOWS_STORE_SCALE_200_ASSETS).toHaveLength(4)
    expect(Object.isFrozen(WINDOWS_STORE_SCALE_200_ASSETS)).toBe(true)
    for (const asset of WINDOWS_STORE_SCALE_200_ASSETS) {
      expect(Object.isFrozen(asset)).toBe(true)
      expect(asset.scale).toBe(200)
      expect(asset.source).toBe(
        `build/appx/${asset.logicalPath.slice('Assets/'.length)}`
      )
      expect(asset.destination).toBe(
        asset.logicalPath.replace(/\.png$/, '.scale-200.png')
      )
    }
  })

  for (const asset of WINDOWS_STORE_SCALE_200_ASSETS) {
    it(`matches the actual PNG dimensions of ${asset.source}`, async () => {
      const png = await readFile(
        resolve(dirname(fileURLToPath(import.meta.url)), '../..', asset.source)
      )
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      )
      expect(png.toString('ascii', 12, 16)).toBe('IHDR')
      expect(png.readUInt32BE(16)).toBe(asset.width)
      expect(png.readUInt32BE(20)).toBe(asset.height)
    })
  }
})
