// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { parseLegacySession } from './session-parser'
import { authorizeLegacySource, scanLegacySource } from './source-scanner'

const fixtureRoot = fileURLToPath(
  new URL('../../../tests/fixtures/legacy-v1/generated/', import.meta.url)
)
const roots: string[] = []
const hash = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

async function stagedFixture(withinGrant = false) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'motrix-v1-fixture-test-'))
  )
  roots.push(root)
  await cp(fixtureRoot, root, { recursive: true })
  const profile = path.join(root, 'profile')
  const downloads = withinGrant
    ? path.join(profile, 'downloads')
    : path.join(root, 'downloads')
  if (withinGrant)
    await cp(path.join(root, 'downloads'), downloads, { recursive: true })
  for (const name of ['download.session', 'system.json']) {
    const file = path.join(profile, name)
    const text = await readFile(file, 'utf8')
    await writeFile(
      file,
      text
        .replaceAll('__FIXTURE_ROOT__', profile)
        .replaceAll('__FIXTURE_DOWNLOADS__', downloads)
        .replaceAll('__FIXTURE_HTTP_PORT__', '18080')
    )
  }
  return {
    root,
    profile,
    downloads,
    source: await authorizeLegacySource(profile),
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Motrix v1.8.19 bundled-engine generated fixtures', () => {
  it('pins binary provenance and verifies unchanged control/torrent bytes', async () => {
    const provenance = JSON.parse(
      await readFile(path.join(fixtureRoot, 'provenance.json'), 'utf8')
    )
    expect(provenance).toMatchObject({
      tag: 'v1.8.19',
      commit: 'a0a1fe90f7e9f6d305ed2b512f62c8d36c2fb95a',
      binarySha256:
        '1527c4d071c16c1266880e93750e385cdd4e9d2a950d7f56cb5a21125e3bd311',
      binaryGitObject: 'f4a274061acbbc22c6eb1ab487ffdc0e80ad1b71',
      version: 'aria2 version 1.36.0',
    })
    for (const file of provenance.files) {
      const bytes = await readFile(path.join(fixtureRoot, file.path))
      expect(bytes.length).toBe(file.bytes)
      expect(hash(bytes)).toBe(file.sha256)
      if (file.path.endsWith('.aria2')) expect(bytes.readUInt16BE(0)).toBe(1)
    }
    const partial = gunzipSync(
      await readFile(path.join(fixtureRoot, provenance.http.savedPayloadGzip))
    )
    expect(partial.length).toBe(provenance.http.savedPayloadBytes)
    expect(hash(partial)).toBe(provenance.http.savedPayloadSha256)
    expect(
      Number(provenance.http.completedLengthAtPauseRequest)
    ).toBeGreaterThan(1024 * 1024)
    expect(partial.length).toBeLessThan(Number(provenance.http.totalLength))
  })

  it('accepts actual v1 serialization with documented isolation overrides, pauses and trailing mirror TAB', async () => {
    const { profile } = await stagedFixture()
    const entries = parseLegacySession(
      await readFile(path.join(profile, 'download.session'))
    )
    expect(entries).toHaveLength(3)
    expect(entries.every((entry) => entry.reason === null)).toBe(true)
    const http = entries.find((entry) => entry.gid === '0123456789abcdef')
    expect(http?.uris).toEqual([
      'http://127.0.0.1:18080/partial.bin',
      'http://127.0.0.1:18080/mirror.bin',
    ])
    expect(http?.options).toMatchObject({
      pause: 'true',
      'no-netrc': 'true',
      'follow-torrent': 'true',
      'follow-metalink': 'true',
      'bt-load-saved-metadata': 'true',
    })
    expect(http?.optionPairs.some(([key]) => key === 'user-agent')).toBe(true)
  })

  it('recognizes external saved torrent metadata without reading outside the profile grant', async () => {
    const { source, downloads } = await stagedFixture()
    const scan = await scanLegacySource(source, async () => false)
    const bt = scan.candidates.find(
      (candidate) => candidate.entry.gid === 'fedcba9876543210'
    )
    expect(bt?.item).toMatchObject({
      type: 'bt',
      selectable: false,
      reason: 'metadata-required',
    })
    expect(bt?.torrent).toBeNull()
    expect(bt?.torrentRelativePath).toBeNull()
    expect(scan.files.map((file) => file.relativePath).sort()).toEqual([
      'download.session',
      'system.json',
      'user.json',
    ])
    // Even removed metadata does not make a scan dereference the external path.
    await rm(downloads, { recursive: true })
    const rescan = await scanLegacySource(source, () => false)
    expect(
      rescan.candidates.find((candidate) => candidate.item.type === 'bt')?.item
        .reason
    ).toBe('metadata-required')
    expect(
      scan.candidates.find((candidate) => candidate.item.type === 'http')?.item
        .selectable
    ).toBe(true)
  })

  it('parses retained private torrent bytes and one-based selection when metadata is explicitly staged inside the grant', async () => {
    // This is a labeled grant variant, not the original generated directory layout.
    const { source } = await stagedFixture(true)
    const scan = await scanLegacySource(source, () => false)
    const bt = scan.candidates.find(
      (candidate) => candidate.entry.gid === 'fedcba9876543210'
    )
    expect(bt?.item).toMatchObject({
      name: 'fixture-bundle',
      type: 'bt',
      selectable: true,
      reason: 'verification-required',
    })
    expect(bt?.torrent?.files).toHaveLength(2)
    expect(bt?.selectedFiles).toEqual([0])
    expect(bt?.selectionKnown).toBe(true)
    expect(bt?.trackers[0]?.[0]).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/announce$/
    )
    expect(bt?.torrentRelativePath).toMatch(/^downloads\/[a-f\d]{40}\.torrent$/)
    const provenance = JSON.parse(
      await readFile(path.join(fixtureRoot, 'provenance.json'), 'utf8')
    )
    expect(bt?.torrent?.infoHash).toBe(provenance.bt.infoHash)
    expect(path.basename(bt?.torrentRelativePath ?? '', '.torrent')).not.toBe(
      provenance.bt.infoHash
    )
  })
})
