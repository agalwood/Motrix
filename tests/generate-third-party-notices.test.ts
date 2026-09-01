import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildThirdPartyBundle,
  collectRuntimePackages,
} from '../scripts/generate-third-party-notices.mjs'

const temporaryDirectories: string[] = []

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-licenses-'))
  temporaryDirectories.push(root)
  return root
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

async function writePackage(
  root: string,
  relativeDirectory: string,
  manifest: Record<string, unknown>,
  license = 'fixture license text\n'
): Promise<void> {
  const directory = path.join(root, relativeDirectory)
  await writeJson(path.join(directory, 'package.json'), manifest)
  if (license) await writeFile(path.join(directory, 'LICENSE'), license)
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('third-party notice generator', () => {
  it('follows runtime declarations without scanning unrelated files', async () => {
    const root = await createFixture()
    await writeJson(path.join(root, 'package.json'), {
      name: 'fixture-app',
      version: '1.0.0',
      dependencies: { alpha: '1.0.0' },
      devDependencies: { buildOnly: '1.0.0' },
    })
    await writePackage(root, 'node_modules/alpha', {
      name: 'alpha',
      version: '1.0.0',
      license: 'MIT',
      dependencies: { beta: '2.0.0' },
      optionalDependencies: { unavailable: '1.0.0' },
    })
    await writePackage(root, 'node_modules/alpha/node_modules/beta', {
      name: 'beta',
      version: '2.0.0',
      license: 'ISC',
    })
    await writePackage(root, 'node_modules/buildOnly', {
      name: 'buildOnly',
      version: '1.0.0',
      license: 'MIT',
    })
    await writePackage(root, 'unrelated/package', {
      name: 'unrelated',
      version: '9.9.9',
      license: 'MIT',
    })

    const graph = await collectRuntimePackages({ projectDir: root })

    expect(graph.packages.map((pkg) => pkg.key)).toEqual([
      'alpha@1.0.0',
      'beta@2.0.0',
    ])
    expect(graph.relationships).toEqual([
      { from: 'alpha@1.0.0', to: 'beta@2.0.0' },
    ])
  })

  it('requires an explicit exception when a package omits its license file', async () => {
    const root = await createFixture()
    await writeJson(path.join(root, 'package.json'), {
      name: 'fixture-app',
      version: '1.0.0',
      dependencies: { alpha: '1.0.0' },
    })
    await writePackage(
      root,
      'node_modules/alpha',
      { name: 'alpha', version: '1.0.0', license: 'MIT' },
      ''
    )

    await expect(collectRuntimePackages({ projectDir: root })).rejects.toThrow(
      'add a reviewed packageOverrides entry'
    )

    await writeFile(path.join(root, 'MIT.txt'), 'MIT fixture text\n')
    const graph = await collectRuntimePackages({
      projectDir: root,
      packageOverrides: {
        'alpha@1.0.0': {
          fallbackLicenseFiles: ['MIT.txt'],
          attribution: 'Fixture Author',
        },
      },
    })
    expect(graph.packages[0]?.licenseFiles[0]?.text).toContain(
      'Attribution: Fixture Author'
    )
  })

  it('preserves a root edge when a direct dependency is also transitive', async () => {
    const root = await createFixture()
    await writeJson(path.join(root, 'package.json'), {
      name: 'fixture-app',
      version: '1.0.0',
      dependencies: { alpha: '1.0.0', beta: '2.0.0' },
    })
    await writePackage(root, 'node_modules/alpha', {
      name: 'alpha',
      version: '1.0.0',
      license: 'MIT',
      dependencies: { beta: '2.0.0' },
    })
    await writePackage(root, 'node_modules/beta', {
      name: 'beta',
      version: '2.0.0',
      license: 'ISC',
    })

    const graph = await collectRuntimePackages({ projectDir: root })

    expect(graph.rootDependencies).toEqual(['alpha@1.0.0', 'beta@2.0.0'])
    expect(graph.relationships).toEqual([
      { from: 'alpha@1.0.0', to: 'beta@2.0.0' },
    ])
  })

  it('builds an SPDX SBOM and consolidated notices for the current release graph', async () => {
    const bundle = await buildThirdPartyBundle()
    const inventory = bundle.files['THIRD_PARTY_DEPENDENCIES.md']
    const licenses = bundle.files['THIRD_PARTY_LICENSES.txt']
    const sbom = JSON.parse(bundle.files['sbom.spdx.json']) as {
      spdxVersion: string
      packages: Array<{
        SPDXID: string
        name: string
        versionInfo?: string
        downloadLocation: string
      }>
      relationships: Array<{
        spdxElementId: string
        relationshipType: string
        relatedSpdxElement: string
      }>
    }

    expect(bundle.packageCount).toBeGreaterThan(100)
    expect(inventory).toContain('| @xyflow/react | 12.11.3 |')
    expect(inventory).toContain('| aria2 | 1.37.0-motrix.11 |')
    expect(inventory).toContain('| motrix.filename-template | 1.1.1 |')
    expect(inventory).toContain('Apple San Francisco tray font')
    expect(licenses).toContain('GNU GENERAL PUBLIC LICENSE')
    expect(licenses).toContain(
      'Chromium software is made available as source code'
    )
    expect(sbom.spdxVersion).toBe('SPDX-2.3')
    expect(sbom.packages).toContainEqual(
      expect.objectContaining({ name: 'Electron', versionInfo: '43.4.0' })
    )
    expect(
      sbom.packages.every(
        (pkg) =>
          pkg.downloadLocation === 'NOASSERTION' ||
          /^(?:https?|git|ssh):/.test(pkg.downloadLocation)
      )
    ).toBe(true)
    const identifiers = new Set([
      'SPDXRef-DOCUMENT',
      ...sbom.packages.map((pkg) => pkg.SPDXID),
    ])
    expect(
      sbom.relationships.every(
        (relationship) =>
          identifiers.has(relationship.spdxElementId) &&
          identifiers.has(relationship.relatedSpdxElement)
      )
    ).toBe(true)

    const rootId = sbom.relationships.find(
      (relationship) => relationship.relationshipType === 'DESCRIBES'
    )?.relatedSpdxElement
    const packageIds = new Map(
      sbom.packages.map((pkg) => [pkg.name, pkg.SPDXID])
    )
    const rootDependencyIds = new Set(
      sbom.relationships
        .filter(
          (relationship) =>
            relationship.spdxElementId === rootId &&
            relationship.relationshipType === 'DEPENDS_ON'
        )
        .map((relationship) => relationship.relatedSpdxElement)
    )
    for (const packageName of [
      'ajv',
      'clsx',
      'pino',
      'tailwind-merge',
      'tailwindcss',
      'tslib',
      'vscode-jsonrpc',
      'ws',
      'zod',
    ]) {
      expect(rootDependencyIds).toContain(packageIds.get(packageName))
    }

    const parsedAgain = JSON.parse(
      await readFile(
        path.join(process.cwd(), 'scripts/third-party-notices.config.json'),
        'utf8'
      )
    )
    expect(parsedAgain.schemaVersion).toBe(1)
  })
})
