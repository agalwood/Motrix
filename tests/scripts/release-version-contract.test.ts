import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import { resolveReleaseMetadata } from '../../scripts/release-metadata.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')

function read(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8')
}

const packageVersion = (JSON.parse(read('package.json')) as { version: string })
  .version
const releaseTag = `v${packageVersion}`
describe('release version contract', () => {
  it('keeps package and Flatpak release metadata aligned', () => {
    expect(
      resolveReleaseMetadata({
        eventName: 'workflow_dispatch',
        refName: 'main',
        refProtected: 'false',
        packageVersion,
      }).version
    ).toBe(packageVersion)

    const metainfo = read('flatpak/app.motrix.native.metainfo.xml')
    const latestRelease =
      /<release version="([^"]+)" date="(\d{4}-\d{2}-\d{2})">/.exec(metainfo)
    expect(latestRelease?.[1]).toBe(packageVersion)
    expect(latestRelease?.[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('advertises only the current release in both READMEs', () => {
    for (const [readmePath, notesPath] of [
      ['README.md', `docs/release-notes/${packageVersion}.md`],
      ['README.zh-CN.md', `docs/release-notes/${packageVersion}.zh-CN.md`],
    ] as const) {
      const source = read(readmePath)
      expect(source).toContain(
        `https://github.com/agalwood/Motrix/releases/tag/${releaseTag}`
      )
      expect(source).toContain(`./${notesPath}`)
      expect(source).toContain(
        `docker.io/motrixapp/motrix-server:${packageVersion}`
      )
      const advertisedReleaseTags = Array.from(
        source.matchAll(
          /https:\/\/github\.com\/agalwood\/Motrix\/releases\/tag\/([^\s)]+)/g
        ),
        (match) => match[1]
      )
      expect(new Set(advertisedReleaseTags)).toEqual(new Set([releaseTag]))
    }
  })

  it('ships paired, tag-pinned notes for the current version', () => {
    const englishPath = `docs/release-notes/${packageVersion}.md`
    const chinesePath = `docs/release-notes/${packageVersion}.zh-CN.md`
    const english = read(englishPath)
    const chinese = read(chinesePath)

    expect(english).toContain(`# Motrix ${packageVersion}`)
    expect(chinese).toContain(`# Motrix ${packageVersion}`)
    expect(english).toContain(
      `https://github.com/agalwood/Motrix/blob/${releaseTag}/${chinesePath}`
    )
    expect(chinese).toContain(
      `https://github.com/agalwood/Motrix/blob/${releaseTag}/${englishPath}`
    )
  })

  it('preserves current release references', () => {
    const english = read(`docs/release-notes/${packageVersion}.md`)
    const chinese = read(`docs/release-notes/${packageVersion}.zh-CN.md`)
    const releaseMetadata = resolveReleaseMetadata({
      eventName: 'workflow_dispatch',
      refName: 'main',
      refProtected: 'false',
      packageVersion,
    })

    expect(english).toContain(
      `https://github.com/agalwood/Motrix/blob/${releaseTag}/docs/docker-server.md`
    )
    expect(chinese).toContain(
      `https://github.com/agalwood/Motrix/blob/${releaseTag}/docs/docker-server.zh-CN.md`
    )

    for (const source of [english, chinese]) {
      expect(source).toContain(
        `docker.io/motrixapp/motrix-server:${packageVersion}`
      )
      expect(source).toContain(
        `ghcr.io/agalwood/motrix-server:${packageVersion}`
      )
      if (releaseMetadata.channel === 'beta') {
        expect(source).toContain('latest/edge')
      }
    }
  })
})
