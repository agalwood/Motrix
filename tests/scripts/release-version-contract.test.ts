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

    expect(english).toContain(
      `https://github.com/agalwood/Motrix/blob/${releaseTag}/docs/docker-server.md`
    )
    expect(chinese).toContain(
      `https://github.com/agalwood/Motrix/blob/${releaseTag}/docs/docker-server.zh-CN.md`
    )

    expect(english).toContain(`motrix-server:${packageVersion}`)
    expect(chinese).toContain(`motrix-server:${packageVersion}`)
  })

  it('preserves beta.5 canonical manifest-order recovery history', () => {
    const english = read('docs/release-notes/2.0.0-beta.5.md')
    const chinese = read('docs/release-notes/2.0.0-beta.5.zh-CN.md')
    const normalizedEnglish = english.replace(/\s+/g, ' ')
    const normalizedChinese = chinese.replace(/\s+/g, ' ')

    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.5/docs/release-notes/2.0.0-beta.4.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.5/docs/release-notes/2.0.0-beta.4.zh-CN.md'
    )
    expect(normalizedEnglish).toContain(
      'canonical code-unit order by its full relative path'
    )
    expect(normalizedEnglish).toContain(
      'instead of inheriting directory-first DFS discovery order'
    )
    expect(normalizedEnglish).toContain(
      'one global sort after inventory collection, and the verifier uses the same code-unit comparator'
    )
    expect(english).toContain('Strict path uniqueness')
    expect(english).toContain('fixed-digest')
    expect(normalizedChinese).toContain(
      '完整相对路径为 key，把每份 Windows signing-input manifest 按 canonical code-unit 顺序排列'
    )
    expect(normalizedChinese).toContain(
      'inventory 收集完成后进行一次全局排序，verifier 使用同一个 code-unit comparator'
    )
    expect(normalizedChinese).toContain('不再沿用目录优先的 DFS 发现顺序')
    expect(chinese).toContain('严格的路径唯一性')
    expect(chinese).toContain('固定摘要验证')
    for (const source of [english, chinese]) {
      expect(source).toContain('v2.0.0-beta.4')
      expect(source).toContain('js-yaml/lib/schema.js')
      expect(source).toContain('js-yaml/lib/schema/…')
      expect(source).toContain('fail-closed')
      expect(source).toContain('.gitattributes')
      expect(source).toContain('text eol=lf')
      expect(source).toContain('SHA-256')
      expect(source).toContain('latest/edge')
      expect(source).toContain('AppImage')
      expect(source).toContain('Flatpak')
      expect(source).toContain('Authenticode')
      expect(source).toContain('SmartScreen')
    }
  })

  it('marks beta.4 as an unpublished attempt superseded by beta.5', () => {
    const english = read('docs/release-notes/2.0.0-beta.4.md')
    const chinese = read('docs/release-notes/2.0.0-beta.4.zh-CN.md')
    const normalizedEnglish = english
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const normalizedChinese = chinese
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')

    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.5/docs/release-notes/2.0.0-beta.4.zh-CN.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.5/docs/release-notes/2.0.0-beta.4.md'
    )
    expect(english).toContain('This release attempt did not complete')
    expect(normalizedEnglish).toContain('All five desktop build jobs')
    expect(normalizedEnglish).toContain('fixed SHA-256 checks passed')
    expect(normalizedEnglish).toContain('2,434 unique entries')
    expect(normalizedEnglish).toContain('full-path dictionary order')
    expect(normalizedEnglish).toContain('no duplicate entries')
    expect(normalizedEnglish).toContain(
      'before any Authenticode secret was read'
    )
    expect(normalizedEnglish).toContain('were not approved')
    expect(chinese).toContain('本次发布尝试未完成')
    expect(normalizedChinese).toContain('5 个桌面构建 job')
    expect(normalizedChinese).toContain('固定 SHA-256 校验也已通过')
    expect(normalizedChinese).toContain('2,434 个无重复条目')
    expect(normalizedChinese).toContain('全路径字典序')
    expect(normalizedChinese).toContain('manifest 中没有重复条目')
    expect(normalizedChinese).toContain('读取任何 Authenticode secret 前')
    expect(normalizedChinese).toContain('macOS 签名环境未获审批')
    for (const source of [english, chinese]) {
      const normalized = source.replace(/^>\s?/gm, '').replace(/\s+/g, ' ')
      expect(source).toContain('v2.0.0-beta.5')
      expect(source).toContain('js-yaml/lib/schema/…')
      expect(source).toContain('js-yaml/lib/schema.js')
      expect(source).toContain('DFS')
      expect(source).toContain('SHA-256')
      expect(source).toMatch(/finaliz/)
      expect(source).toMatch(/assemble/i)
      expect(source).toContain('GitHub Release')
      expect(source).toContain('R2')
      expect(source).toContain('container')
      expect(source).toContain('Snap')
      expect(source).toContain('arm64')
      expect(source).toContain('amd64')
      expect(normalized).toContain('strict Snap')
      expect(source).toContain('steps=[]')
      expect(normalized).toContain('nested artifact staging')
      expect(normalized).toContain('Store credential validation')
      expect(normalized).toContain('Store upload')
      expect(normalized).toContain('public verification')
      expect(source).toContain('latest/edge')
      expect(source).toContain('Docker Hub')
      expect(source).toContain('GHCR')
      expect(source).toContain('AppImage')
      expect(source).toContain('Flatpak')
      expect(source).toContain('Authenticode')
      expect(source).toContain('SmartScreen')
    }
  })

  it('marks beta.3 as an unpublished attempt superseded by beta.4', () => {
    const english = read('docs/release-notes/2.0.0-beta.3.md')
    const chinese = read('docs/release-notes/2.0.0-beta.3.zh-CN.md')
    const normalizedEnglish = english
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')

    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.4/docs/release-notes/2.0.0-beta.3.zh-CN.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.4/docs/release-notes/2.0.0-beta.3.md'
    )
    expect(english).toContain('This release attempt did not complete')
    expect(normalizedEnglish).toContain(
      'four non-Windows desktop build targets'
    )
    expect(english).toContain('Intended downloads (not published)')
    expect(english).toContain('external distribution remained zero')
    expect(english).toContain('failed closed')
    expect(chinese).toContain('本次发布尝试未完成')
    expect(chinese).toContain('4 个非 Windows 桌面构建目标')
    expect(chinese).toContain('原计划下载（未发布）')
    expect(chinese).toContain('外部分发为零')
    expect(chinese).toContain('fail closed')
    for (const source of [english, chinese]) {
      expect(source).toContain('v2.0.0-beta.4')
      expect(source).toContain('electron-builder.signing.json')
      expect(source).toContain('commit')
      expect(source).toContain('CRLF')
      expect(source).toContain('SHA-256')
      expect(source).toContain('macOS')
      expect(source).toContain('finalize')
      expect(source).toContain('assemble')
      expect(source).toContain('GitHub Release')
      expect(source).toContain('R2')
      expect(source).toContain('container')
      expect(source).toContain('Snap')
      expect(source).toContain('steps=[]')
      expect(source).toContain('latest/edge')
      expect(source).toContain('Docker Hub')
      expect(source).toContain('GHCR')
      expect(source).toContain('AppImage')
      expect(source).toContain('Authenticode')
      expect(source).toContain('SmartScreen')
    }
  })

  it('marks beta.2 as an unpublished attempt superseded by beta.3', () => {
    const english = read('docs/release-notes/2.0.0-beta.2.md')
    const chinese = read('docs/release-notes/2.0.0-beta.2.zh-CN.md')

    expect(english).toContain('This release attempt did not complete')
    expect(english).toContain('Intended downloads (not published)')
    expect(chinese).toContain('本次发布尝试未完成')
    expect(chinese).toContain('原计划下载（未发布）')
    for (const source of [english, chinese]) {
      expect(source).toContain('v2.0.0-beta.3')
      expect(source).toContain('$GITHUB_SHA')
      expect(source).toContain('PowerShell')
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
