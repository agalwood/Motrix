import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'

export const STORE_IDS = ['chrome', 'edge', 'firefox']
export const CHROME_EXTENSION_ID = 'lggbokfckofcgjndaboioakcmincinpo'
export const FIREFOX_EXTENSION_ID = 'motrix-extension@motrix.app'

export function releaseFiles(tag) {
  if (
    typeof tag !== 'string' ||
    tag.trim() !== tag ||
    !/^v\d+\.\d+\.\d+$/.test(tag)
  ) {
    throw new Error('Release tag must use vX.Y.Z format')
  }
  const version = tag.slice(1)
  const prefix = `motrix-extension-${version}`
  return {
    version,
    chromium: `${prefix}-chrome-edge.zip`,
    firefox: `${prefix}-firefox.zip`,
    source: `${prefix}-source.zip`,
  }
}

export function selectStores(selection) {
  if (selection === 'all') return [...STORE_IDS]
  if (STORE_IDS.includes(selection)) return [selection]
  throw new Error('Store must be all, chrome, edge, or firefox')
}

export function parseDryRun(value) {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('DRY_RUN must be explicitly set to true or false')
}

function readArchive(path, wanted) {
  const names = new Set()
  const files = unzipSync(readFileSync(path), {
    filter(entry) {
      if (
        entry.name.startsWith('/') ||
        entry.name.includes('\\') ||
        entry.name.split('/').includes('..') ||
        names.has(entry.name)
      ) {
        throw new Error(`Invalid or duplicate ZIP entry in ${basename(path)}`)
      }
      names.add(entry.name)
      if (!wanted.includes(entry.name)) return false
      if (entry.originalSize > 8 * 1024 * 1024) {
        throw new Error(`Oversized metadata in ${basename(path)}`)
      }
      return true
    },
  })
  return { names, files }
}

function readJsonEntry(archive, name) {
  const value = archive.files[name]
  if (!value) throw new Error(`ZIP is missing ${name}`)
  return JSON.parse(Buffer.from(value).toString('utf8'))
}

export function verifyRelease(directory, tag) {
  const files = releaseFiles(tag)
  const metadata = JSON.parse(
    readFileSync(resolve(directory, 'release.json'), 'utf8')
  )
  if (
    metadata.tagName !== tag ||
    metadata.isDraft !== false ||
    metadata.isPrerelease !== false
  ) {
    throw new Error(
      'Expected a published, non-prerelease GitHub Release matching the tag'
    )
  }

  const expected = [files.chromium, files.firefox, files.source]
  const checksums = new Map()
  const lines = readFileSync(resolve(directory, 'SHA256SUMS.txt'), 'utf8')
    .trim()
    .split(/\r?\n/)
  for (const line of lines) {
    const match = /^([a-fA-F0-9]{64}) [ *](\S+)$/.exec(line)
    // release.yml runs `sha256sum ./*.zip`, which preserves the ./ prefix.
    const name = match?.[2].replace(/^\.\//, '')
    if (!match || !expected.includes(name) || checksums.has(name)) {
      throw new Error(
        'Checksum manifest must list each expected ZIP exactly once'
      )
    }
    checksums.set(name, match[1].toLowerCase())
  }
  for (const name of expected) {
    const digest = createHash('sha256')
      .update(readFileSync(resolve(directory, name)))
      .digest('hex')
    if (checksums.get(name) !== digest) {
      throw new Error(`Missing or mismatched SHA256: ${name}`)
    }
  }

  for (const [store, name] of [
    ['chrome', files.chromium],
    ['firefox', files.firefox],
  ]) {
    const archive = readArchive(resolve(directory, name), ['manifest.json'])
    const manifest = readJsonEntry(archive, 'manifest.json')
    if (manifest.version !== files.version || manifest.manifest_version !== 3) {
      throw new Error(`${store} manifest version does not match ${tag} / MV3`)
    }
    if (store === 'firefox') {
      if (
        manifest.browser_specific_settings?.gecko?.id !== FIREFOX_EXTENSION_ID
      ) {
        throw new Error('Firefox extension identity does not match Motrix')
      }
      if (!manifest.background?.scripts?.length) {
        throw new Error('Firefox package is missing its background script')
      }
    } else if (!manifest.background?.service_worker) {
      throw new Error('Chromium package is missing its service worker')
    }
  }

  const source = readArchive(resolve(directory, files.source), [
    'package.json',
    'pnpm-workspace.yaml',
  ])
  if (readJsonEntry(source, 'package.json').version !== files.version) {
    throw new Error('Source package version does not match the release')
  }
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md']) {
    if (!source.names.has(name))
      throw new Error(`Source ZIP is missing ${name}`)
  }
  // pnpm patch files must accompany the lockfile for AMO to rebuild the source.
  const workspace = Buffer.from(source.files['pnpm-workspace.yaml']).toString(
    'utf8'
  )
  for (const [patch] of workspace.matchAll(/patches\/[\w@./+-]+\.patch/g)) {
    if (!source.names.has(patch))
      throw new Error(`Source ZIP is missing ${patch}`)
  }
  return files
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv[2] === 'plan') {
      const files = releaseFiles(process.env.RELEASE_TAG ?? '')
      const stores = selectStores(process.env.STORE_SELECTION ?? '')
      parseDryRun(process.env.DRY_RUN)
      const output = `version=${files.version}\nstores=${JSON.stringify(stores)}\n`
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, output)
      else process.stdout.write(output)
    } else if (process.argv[2] === 'verify') {
      verifyRelease(process.argv[3], process.argv[4])
      console.log(
        'Verified release metadata, all ZIP checksums, manifests, and source inputs'
      )
    } else {
      throw new Error(
        'Usage: store-release.mjs plan | verify <directory> <tag>'
      )
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
