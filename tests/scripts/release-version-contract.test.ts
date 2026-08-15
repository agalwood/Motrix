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
  it('keeps package metadata, server fallback, and Flatpak metadata aligned', () => {
    expect(
      resolveReleaseMetadata({
        eventName: 'workflow_dispatch',
        refName: 'main',
        refProtected: 'false',
        packageVersion,
      }).version
    ).toBe(packageVersion)

    const serverSource = read('src/server/index.ts')
    expect(serverSource).toContain(
      "import packageJson from '../../package.json' with { type: 'json' }"
    )
    expect(serverSource).toContain(
      'process.env.MOTRIX_APP_VERSION ?? packageJson.version'
    )

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

  it('preserves beta.2 recovery and distribution disclosures', () => {
    const betaVersion = '2.0.0-beta.2'
    const betaTag = `v${betaVersion}`
    const english = read(`docs/release-notes/${betaVersion}.md`)
    const chinese = read(`docs/release-notes/${betaVersion}.zh-CN.md`)

    expect(english).toContain(
      `https://github.com/agalwood/Motrix/blob/${betaTag}/docs/docker-server.md`
    )
    expect(chinese).toContain(
      `https://github.com/agalwood/Motrix/blob/${betaTag}/docs/docker-server.zh-CN.md`
    )

    for (const source of [english, chinese]) {
      expect(source).toContain(`motrix-server:${betaVersion}`)
      expect(source).toContain('v2.0.0-beta.1')
      expect(source).toContain('GitHub Release')
      expect(source).toContain('R2')
      expect(source).toContain('Snap')
      expect(source).toContain('AppImage')
      expect(source).toContain('Authenticode')
      expect(source).toContain('SmartScreen')
    }
  })

  it('marks beta.1 as an unpublished attempt superseded by beta.2', () => {
    const english = read('docs/release-notes/2.0.0-beta.1.md')
    const chinese = read('docs/release-notes/2.0.0-beta.1.zh-CN.md')

    expect(english).toContain('This release attempt did not complete')
    expect(english).toContain('Intended downloads (not published)')
    expect(chinese).toContain('本次发布尝试未完成')
    expect(chinese).toContain('原计划下载（未发布）')
    for (const source of [english, chinese]) {
      expect(source).toContain('v2.0.0-beta.2')
    }
  })
})
