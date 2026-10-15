import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const packageRoot = resolve(import.meta.dirname, '..')
const sourceRoot = join(packageRoot, 'src')
const supportedExtensions = new Set(['.mjs', '.ts', '.tsx'])
const ignoredDirectories = new Set(['.cache', 'dist', 'node_modules'])
const moduleSpecifierPattern =
  /(?:\bfrom\s*|\b(?:import|require)\s*\(\s*|\b(?:vi|jest)\.(?:mock|doMock|unmock)\s*\(\s*|\bimport\s+)(['"])([^'"\r\n]+)\1/g
const codeExtensionPattern = /\.(?:[cm]?[jt]sx?)(?:\?|$)/

const files = []
const visit = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) visit(path)
    else if (supportedExtensions.has(extname(entry.name))) files.push(path)
  }
}
visit(packageRoot)

const violations = []
const packageJson = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8')
)
for (const name of ['@types/chrome', '@types/firefox-webext-browser']) {
  if (packageJson.dependencies?.[name] || packageJson.devDependencies?.[name]) {
    violations.push(
      `${name} introduces competing browser globals; use @wxt-dev/browser through @/shared/browser`
    )
  }
}
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const sourceRelative = relative(sourceRoot, file)
  const isSourceFile = file.startsWith(`${sourceRoot}/`)
  const isTestFile =
    sourceRelative.includes('__tests__/') ||
    /(?:^|\/)tests?\//u.test(sourceRelative) ||
    /\.(?:test|spec)\.[^.]+$/u.test(sourceRelative)

  if (isSourceFile && !isTestFile) {
    const restrictedProductionCapabilities = [
      {
        token: '.setForTest(',
        allowed: new Set(['background/EndpointConfigStore.ts']),
      },
      {
        token: '.forAuthorityForTest(',
        allowed: new Set(['background/mbp1/credential-store.ts']),
      },
      {
        token: 'createRemoteBackendPolicyStoreForTest(',
        allowed: new Set(['background/RemoteBackendPolicyStore.ts']),
      },
      {
        token: '.issueLifecycleWriter(',
        allowed: new Set([
          'background/EndpointConfigStore.ts',
          'background/EndpointCatalogService.ts',
        ]),
      },
      {
        token: '.setForIssuedLifecycleWriter(',
        allowed: new Set(['background/EndpointConfigStore.ts']),
      },
    ]
    for (const rule of restrictedProductionCapabilities) {
      if (!source.includes(rule.token) || rule.allowed.has(sourceRelative)) {
        continue
      }
      const line = source
        .slice(0, source.indexOf(rule.token))
        .split('\n').length
      violations.push(
        `${sourceRelative}:${line} test/internal mutation capability is forbidden in production: ${rule.token}`
      )
    }

    // The pre-MBP1 remote path accepted a server-issued pairToken, persisted
    // it in PairTokenStore, and could place a token in a WebSocket URL. Those
    // identifiers are retired protocol surface, not merely unused code. Keep
    // this as a source-level tombstone so a later refactor cannot silently
    // reintroduce token fallback beside MDXP-over-MBP1.
    const retiredRemoteTokenSurface = [
      {
        token: 'PairTokenStore',
        allowed: new Set(),
      },
      {
        token: 'pairToken',
        allowed: new Set(['background/storage-migrations.ts']),
      },
      {
        token: 'bg.setPairToken',
        allowed: new Set(),
      },
      {
        token: '?token=',
        allowed: new Set(['background/mbp1/frames.ts']),
      },
    ]
    for (const rule of retiredRemoteTokenSurface) {
      if (!source.includes(rule.token) || rule.allowed.has(sourceRelative)) {
        continue
      }
      const line = source
        .slice(0, source.indexOf(rule.token))
        .split('\n').length
      violations.push(
        `${sourceRelative}:${line} retired remote token surface is forbidden in production: ${rule.token}`
      )
    }
  }
  for (const match of source.matchAll(moduleSpecifierPattern)) {
    const specifier = match[2]
    if (!specifier) continue

    const line = source.slice(0, match.index).split('\n').length
    const location = `${relative(packageRoot, file)}:${line}`
    if (
      isSourceFile &&
      !isTestFile &&
      ['@wxt-dev/browser', 'webextension-polyfill'].includes(specifier) &&
      ![
        'shared/browser.ts',
        'shared/browser.safari.ts',
        'shared/browser-types.d.ts',
      ].includes(sourceRelative)
    ) {
      violations.push(
        `${location} browser APIs and types must come from @/shared/browser`
      )
    }
    // The extensionless-specifier convention only applies to internal
    // TypeScript modules (relative imports and the @/ alias). Node ESM scripts
    // require explicit file extensions. Third-party packages are
    // free to require an explicit extension in their subpath exports map
    // (e.g. @noble/curves and @noble/hashes v2.x ship no extensionless
    // subpaths at all — `@noble/curves/ed25519` does not resolve, only
    // `@noble/curves/ed25519.js` does), so bare package specifiers are
    // exempt from this check.
    const isInternalSpecifier =
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier.startsWith('@/')
    const isNodeEsmScript = extname(file) === '.mjs'
    if (
      isInternalSpecifier &&
      codeExtensionPattern.test(specifier) &&
      !isNodeEsmScript
    ) {
      violations.push(
        `${location} code import must be extensionless: ${specifier}`
      )
    }
    if (
      file.startsWith(`${sourceRoot}/`) &&
      (specifier.startsWith('./') || specifier.startsWith('../'))
    ) {
      violations.push(`${location} source import must use @/: ${specifier}`)
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Verified import conventions in ${files.length} files`)
}
