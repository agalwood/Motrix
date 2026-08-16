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
const restrictedPublicLanguage =
  /\b(?:certificates?|credentials?|secrets?|leak(?:ed|age|s)?|rotat(?:e|ed|ing|ion)|security incidents?)\b|证书|凭据|密钥|泄露|轮换|安全事件/iu
const secretLikeIdentifier =
  /\b[A-Z][A-Z0-9_]*(?:SECRET|CERT|KEY|TOKEN|CREDENTIAL)[A-Z0-9_]*\b/u

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

  it('records beta.7 as an unpublished attempt superseded by beta.8', () => {
    const english = read('docs/release-notes/2.0.0-beta.7.md')
    const chinese = read('docs/release-notes/2.0.0-beta.7.zh-CN.md')
    const normalizedEnglish = english
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const normalizedChinese = chinese
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')

    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.8/docs/release-notes/2.0.0-beta.7.zh-CN.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.8/docs/release-notes/2.0.0-beta.7.md'
    )
    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.8/docs/release-notes/2.0.0-beta.8.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.8/docs/release-notes/2.0.0-beta.8.zh-CN.md'
    )
    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.7/docs/release-notes/2.0.0-beta.6.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.7/docs/release-notes/2.0.0-beta.6.zh-CN.md'
    )
    expect(normalizedEnglish).toContain(
      'The macOS and Windows Finalize gates did not pass'
    )
    expect(normalizedEnglish).toContain(
      'Both the Build/Release workflow and the Snap publication workflow were canceled'
    )
    expect(normalizedEnglish).toContain(
      'No GitHub Release, R2 update feed, Docker Hub or GHCR container image, or public Snap distribution was created'
    )
    expect(normalizedEnglish).toContain('External distribution remained zero')
    expect(normalizedChinese).toContain(
      'macOS 与 Windows Finalize 门禁均未通过'
    )
    expect(normalizedChinese).toContain(
      'Build/Release workflow 与 Snap 发布 workflow 均被取消'
    )
    expect(normalizedChinese).toContain(
      '没有创建 GitHub Release、R2 更新数据源、 Docker Hub 或 GHCR 容器镜像，也没有产生公开 Snap 分发'
    )
    expect(normalizedChinese).toContain('外部分发为零')
  })

  it('records beta.8 as an unpublished desktop and Snap attempt', () => {
    const english = read('docs/release-notes/2.0.0-beta.8.md')
    const chinese = read('docs/release-notes/2.0.0-beta.8.zh-CN.md')
    const normalizedEnglish = english
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const normalizedChinese = chinese
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const metainfo = read('flatpak/app.motrix.native.metainfo.xml')
    const beta8Metainfo =
      /<release version="2\.0\.0-beta\.8"[\s\S]*?<\/release>/.exec(
        metainfo
      )?.[0] ?? ''
    const beta7Metainfo =
      /<release version="2\.0\.0-beta\.7"[\s\S]*?<\/release>/.exec(
        metainfo
      )?.[0] ?? ''

    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.9/docs/release-notes/2.0.0-beta.8.zh-CN.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.9/docs/release-notes/2.0.0-beta.8.md'
    )
    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.9/docs/release-notes/2.0.0-beta.9.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.9/docs/release-notes/2.0.0-beta.9.zh-CN.md'
    )
    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.8/docs/release-notes/2.0.0-beta.7.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.8/docs/release-notes/2.0.0-beta.7.zh-CN.md'
    )
    expect(normalizedEnglish).toContain('Motrix 2.0.0-beta.8 was not published')
    expect(normalizedEnglish).toContain(
      'All five desktop build jobs completed successfully'
    )
    expect(normalizedEnglish).toContain(
      'The explicitly unsigned Windows Finalize job completed Electron Builder and produced its final package candidates'
    )
    expect(normalizedEnglish).toContain(
      'The final verifier then stopped before package scanning because its isolated tool dependency set could not resolve `@electron/asar`'
    )
    expect(normalizedEnglish).toContain(
      'Both macOS Finalize jobs were canceled without running while awaiting approval'
    )
    expect(normalizedEnglish).toContain(
      'Desktop assembly, the GitHub Release, R2 update-feed publication, and Docker Hub/GHCR container publication were canceled without running'
    )
    expect(normalizedEnglish).toContain(
      'The source gate and strict `amd64` and `arm64` Snap builds completed'
    )
    expect(normalizedEnglish).toContain(
      "Both artifacts passed package verification and were uploaded to the workflow's internal artifact set"
    )
    expect(normalizedEnglish).toContain(
      'The `amd64` upload reached Store processing, which required human review of the `personal-files` `allow-installation` declaration'
    )
    expect(normalizedEnglish).toContain(
      'The Store did not return an exact revision, and the `arm64` Store upload did not start'
    )
    expect(normalizedEnglish).toContain(
      'Public `latest/edge` remained unchanged at amd64 Motrix 1.8.19 with no arm64 entry'
    )
    expect(normalizedEnglish).toContain('External distribution remained zero')
    expect(normalizedChinese).toContain('5 个桌面构建 job 均成功完成')
    expect(normalizedChinese).toContain(
      'Windows Finalize job 成功完成 Electron Builder'
    )
    expect(normalizedChinese).toContain('最终 verifier 在扫描安装包前停止')
    expect(chinese).toContain('`@electron/asar`')
    expect(normalizedChinese).toContain(
      '两个 macOS Finalize job 在等待审批时被取消，均未执行'
    )
    expect(normalizedChinese).toContain(
      '桌面产物组装、GitHub Release、R2 更新数据源发布以及 Docker Hub/GHCR 容器发布均被取消且未执行'
    )
    expect(normalizedChinese).toContain(
      'source gate 以及 `amd64`、`arm64` 两个 strict Snap 构建均完成'
    )
    expect(normalizedChinese).toContain(
      'Store 要求人工审核 `personal-files` 的 `allow-installation` 声明'
    )
    expect(normalizedChinese).toContain(
      'Store 没有返回精确 revision，`arm64` Store upload 也未开始'
    )
    expect(normalizedChinese).toContain(
      '公开 `latest/edge` 保持不变，仍为 amd64 Motrix 1.8.19'
    )
    expect(normalizedChinese).toContain('外部分发为零')
    for (const source of [
      english,
      chinese,
      read('docs/release-notes/2.0.0-beta.7.md'),
      read('docs/release-notes/2.0.0-beta.7.zh-CN.md'),
      beta8Metainfo,
      beta7Metainfo,
    ]) {
      expect(source).not.toMatch(restrictedPublicLanguage)
      expect(source).not.toMatch(secretLikeIdentifier)
    }
    expect(metainfo).toContain(
      '<release version="2.0.0-beta.8" date="2026-08-16">'
    )
    expect(metainfo).toContain('Unsigned Windows Builder')
    expect(metainfo).toContain(
      'amd64 Snap upload required personal-files allow-installation review'
    )
  })

  it('records beta.9 as an unpublished finalization attempt', () => {
    const english = read('docs/release-notes/2.0.0-beta.9.md')
    const chinese = read('docs/release-notes/2.0.0-beta.9.zh-CN.md')
    const normalizedEnglish = english
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const normalizedChinese = chinese
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const metainfo = read('flatpak/app.motrix.native.metainfo.xml')
    const beta9Metainfo =
      /<release version="2\.0\.0-beta\.9"[\s\S]*?<\/release>/.exec(
        metainfo
      )?.[0] ?? ''
    const normalizedBeta9Metainfo = beta9Metainfo.replace(/\s+/g, ' ')

    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.10/docs/release-notes/2.0.0-beta.9.zh-CN.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.10/docs/release-notes/2.0.0-beta.9.md'
    )
    expect(normalizedEnglish).toContain('Motrix 2.0.0-beta.9 was not published')
    expect(normalizedEnglish).toContain(
      'All five desktop build jobs completed successfully'
    )
    expect(normalizedEnglish).toContain(
      'The explicitly unsigned Windows Finalize job and the Apple Silicon macOS Finalize job both completed their full package verification'
    )
    expect(normalizedEnglish).toContain(
      'Intel macOS Finalize stopped in the macOS 26 signing runtime before its final package set was produced'
    )
    expect(normalizedEnglish).toContain(
      'The complete desktop platform-set gate therefore prevented assembly'
    )
    expect(normalizedEnglish).toContain(
      'The GitHub Release, R2 update feed, and Docker Hub/GHCR container publication did not run'
    )
    expect(normalizedEnglish).toContain(
      'The protected prerelease Snap workflow passed source validation and, as designed, skipped both architecture builds and Store publication'
    )
    expect(normalizedEnglish).toContain('External distribution remained zero')
    expect(normalizedChinese).toContain('Motrix 2.0.0-beta.9 未发布')
    expect(normalizedChinese).toContain('5 个桌面构建 job 均成功完成')
    expect(normalizedChinese).toContain(
      'Windows Finalize job 与 Apple Silicon macOS Finalize job 均完成了完整安装包验证'
    )
    expect(normalizedChinese).toContain(
      'Intel macOS Finalize 在生成最终安装包集合前停止于 macOS 26 签名 runtime'
    )
    expect(normalizedChinese).toContain('完整桌面平台集合门禁阻止了产物组装')
    expect(normalizedChinese).toContain(
      '受保护的预发布 Snap workflow 通过 source validation 后，按设计跳过了两个架构构建与 Store 发布'
    )
    expect(normalizedChinese).toContain('外部分发 为零')
    for (const source of [english, chinese]) {
      expect(source).toContain('2.0.0-beta.9')
      expect(source).toContain('2.0.0-beta.10')
      expect(source).not.toMatch(restrictedPublicLanguage)
      expect(source).not.toMatch(secretLikeIdentifier)
    }
    expect(metainfo).toContain(
      '<release version="2.0.0-beta.9" date="2026-08-16">'
    )
    expect(beta9Metainfo).toContain('All five desktop builds')
    expect(normalizedBeta9Metainfo).toContain(
      'Intel macOS finalization stopped in the signing runtime'
    )
    expect(normalizedBeta9Metainfo).toContain(
      'The prerelease Snap workflow stopped after source validation'
    )
    expect(normalizedBeta9Metainfo).toContain(
      'external distribution remained zero'
    )
    expect(beta9Metainfo).not.toMatch(restrictedPublicLanguage)
    expect(beta9Metainfo).not.toMatch(secretLikeIdentifier)
  })

  it('records beta.10 as an unpublished assembly attempt', () => {
    const english = read('docs/release-notes/2.0.0-beta.10.md')
    const chinese = read('docs/release-notes/2.0.0-beta.10.zh-CN.md')
    const normalizedEnglish = english
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const normalizedChinese = chinese
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const metainfo = read('flatpak/app.motrix.native.metainfo.xml')
    const beta10Metainfo =
      /<release version="2\.0\.0-beta\.10"[\s\S]*?<\/release>/.exec(
        metainfo
      )?.[0] ?? ''
    const normalizedBeta10Metainfo = beta10Metainfo.replace(/\s+/g, ' ')

    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.11/docs/release-notes/2.0.0-beta.10.zh-CN.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.11/docs/release-notes/2.0.0-beta.10.md'
    )
    expect(normalizedEnglish).toContain(
      'Motrix 2.0.0-beta.10 was not published'
    )
    expect(normalizedEnglish).toContain(
      'All five desktop build jobs completed successfully'
    )
    expect(normalizedEnglish).toContain(
      'The explicitly unsigned Windows Finalize job and both macOS Finalize jobs also completed their full package verification'
    )
    expect(normalizedEnglish).toContain(
      'Each architecture supplied its expected ZIP and DMG entries, including a metadata-identical duplicate DMG entry'
    )
    expect(normalizedEnglish).toContain(
      'The failure occurred before a release bundle was created'
    )
    expect(normalizedChinese).toContain('Motrix 2.0.0-beta.10 未发布')
    expect(normalizedChinese).toContain('5 个桌面构建 job 均成功完成')
    expect(normalizedChinese).toContain(
      'Windows Finalize job 与两个 macOS Finalize job 也都完成了完整安装包验证'
    )
    expect(normalizedChinese).toContain(
      '其中包含一条元数据完全相同的重复 DMG 条目'
    )
    expect(normalizedChinese).toContain('失败发生在 release bundle 创建之前')
    for (const source of [english, chinese]) {
      expect(source).toContain('Snap')
      expect(source).toContain('2.0.0-beta.11')
      expect(source).not.toMatch(restrictedPublicLanguage)
      expect(source).not.toMatch(secretLikeIdentifier)
    }
    expect(normalizedEnglish).toContain(
      'The GitHub Release, R2 update feed, and Docker Hub/GHCR container publication did not run'
    )
    expect(normalizedEnglish).toContain('External distribution remained zero')
    expect(normalizedChinese).toContain(
      'GitHub Release、R2 更新数据源以及 Docker Hub/GHCR 容器发布均未执行'
    )
    expect(normalizedChinese).toContain('外部分发 为零')
    expect(metainfo).toContain(
      '<release version="2.0.0-beta.10" date="2026-08-16">'
    )
    expect(normalizedBeta10Metainfo).toContain(
      'All five desktop builds and all three Finalize jobs succeeded'
    )
    expect(normalizedBeta10Metainfo).toContain(
      'Assembly rejected the real macOS updater manifest shape'
    )
    expect(normalizedBeta10Metainfo).toContain(
      'external distribution remained zero'
    )
    expect(beta10Metainfo).not.toMatch(restrictedPublicLanguage)
    expect(beta10Metainfo).not.toMatch(secretLikeIdentifier)
  })

  it('records beta.11 as an unpublished Linux manifest assembly attempt', () => {
    const english = read('docs/release-notes/2.0.0-beta.11.md')
    const chinese = read('docs/release-notes/2.0.0-beta.11.zh-CN.md')
    const normalizedEnglish = english.replace(/\s+/g, ' ')
    const normalizedChinese = chinese.replace(/\s+/g, ' ')
    const metainfo = read('flatpak/app.motrix.native.metainfo.xml')
    const beta11Metainfo =
      /<release version="2\.0\.0-beta\.11"[\s\S]*?<\/release>/.exec(
        metainfo
      )?.[0] ?? ''
    const normalizedBeta11Metainfo = beta11Metainfo.replace(/\s+/g, ' ')

    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.12/docs/release-notes/2.0.0-beta.11.zh-CN.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.12/docs/release-notes/2.0.0-beta.11.md'
    )
    expect(normalizedEnglish).toContain(
      'Motrix 2.0.0-beta.11 was not published'
    )
    expect(normalizedEnglish).toContain('all five desktop Build jobs')
    expect(normalizedEnglish).toContain(
      'The explicitly unsigned Windows Finalize job and both macOS Finalize jobs also completed their full package verification'
    )
    expect(normalizedEnglish).toContain(
      'listed the expected DEB once and the expected RPM twice with identical basename, size, and SHA-512 metadata'
    )
    expect(normalizedChinese).toContain('Motrix 2.0.0-beta.11 未发布')
    expect(normalizedChinese).toContain('5 个桌面 Build job 全部成功')
    expect(normalizedChinese).toContain(
      '两条 basename、大小和 SHA-512 元数据完全相同的预期 RPM'
    )
    for (const source of [english, chinese]) {
      expect(source).toContain('Snap')
      expect(source).toContain('2.0.0-beta.12')
      expect(source).not.toMatch(restrictedPublicLanguage)
      expect(source).not.toMatch(secretLikeIdentifier)
    }
    expect(normalizedEnglish).toContain(
      'The GitHub Release, R2 update feed, and Docker Hub/GHCR container publication did not run'
    )
    expect(normalizedEnglish).toContain('External distribution remained zero')
    expect(normalizedChinese).toContain(
      'GitHub Release、R2 更新数据源以及 Docker Hub/GHCR 容器发布均未执行'
    )
    expect(normalizedChinese).toContain('外部分发 为零')
    expect(metainfo).toContain(
      '<release version="2.0.0-beta.11" date="2026-08-16">'
    )
    expect(normalizedBeta11Metainfo).toContain(
      'All five desktop builds and all three Finalize jobs succeeded'
    )
    expect(normalizedBeta11Metainfo).toContain(
      'a metadata-identical duplicate RPM entry'
    )
    expect(normalizedBeta11Metainfo).toContain(
      'external distribution remained zero'
    )
    expect(beta11Metainfo).not.toMatch(restrictedPublicLanguage)
    expect(beta11Metainfo).not.toMatch(secretLikeIdentifier)
  })

  it('records beta.12 canonical manifest recovery and public outcome', () => {
    const english = read('docs/release-notes/2.0.0-beta.12.md')
    const chinese = read('docs/release-notes/2.0.0-beta.12.zh-CN.md')
    const normalizedEnglish = english.replace(/\s+/g, ' ')
    const normalizedChinese = chinese.replace(/\s+/g, ' ')
    const metainfo = read('flatpak/app.motrix.native.metainfo.xml')
    const beta12Metainfo =
      /<release version="2\.0\.0-beta\.12"[\s\S]*?<\/release>/.exec(
        metainfo
      )?.[0] ?? ''
    const normalizedBeta12Metainfo = beta12Metainfo.replace(/\s+/g, ' ')

    expect(normalizedEnglish).toContain(
      'Validates every source updater manifest against the exact allowlisted basenames, file sizes, and SHA-512 values'
    )
    expect(normalizedEnglish).toContain(
      'Accepts and collapses only duplicate entries whose basename, size, and SHA-512 metadata are identical'
    )
    expect(normalizedEnglish).toContain(
      'Regenerates the published Linux and Windows updater manifests from the canonical verified package set'
    )
    expect(normalizedEnglish).toContain(
      'Each Linux feed therefore contains exactly one DEB and one RPM entry'
    )
    expect(normalizedEnglish).toContain(
      '17 release assets and four beta updater manifests pass the recovered path'
    )
    expect(normalizedChinese).toContain(
      '按精确 allowlist basename、文件大小与 SHA-512 值验证 每一份 updater 源 manifest'
    )
    expect(normalizedChinese).toContain(
      '只接受并折叠 basename、大小与 SHA-512 元数据完全相同的重复条目'
    )
    expect(normalizedChinese).toContain(
      '重新生成公开的 Linux 与 Windows updater manifest'
    )
    expect(normalizedChinese).toContain(
      '每份 Linux 更新数据源都只包含一条 DEB 与 一条 RPM'
    )
    expect(normalizedEnglish).toContain(
      'Motrix 2.0.0-beta.12 was publicly distributed'
    )
    expect(normalizedEnglish).toContain(
      'The GitHub prerelease published 21 assets'
    )
    expect(normalizedEnglish).toContain(
      'The recovered R2 job published 17 versioned assets and then the four beta updater manifests'
    )
    expect(normalizedEnglish).toContain(
      'Both registry digests were signed with the tag workflow identity'
    )
    expect(normalizedEnglish).toContain(
      'the final provenance contract expecting an obsolete Docker Buildx URL instead of the real repository workflow run and attempt'
    )
    expect(normalizedEnglish).toContain(
      'The desktop release and immutable container images remain public, and the mutable beta update feeds advanced successfully to beta.12'
    )
    expect(normalizedChinese).toContain('Motrix 2.0.0-beta.12 已公开分发')
    expect(normalizedChinese).toContain('GitHub 预发布版发布了 21 个产物')
    expect(normalizedChinese).toContain(
      '恢复后的 R2 job 先发布 17 个带版本产物， 再发布 4 份 beta updater manifest'
    )
    expect(normalizedChinese).toContain(
      '剩余失败来自最终 provenance 契约仍期待旧 Docker Buildx URL'
    )
    for (const source of [english, chinese]) {
      expect(source).toContain('Snap')
      expect(source).toContain('latest/edge')
      expect(source).toContain('AppImage')
      expect(source).toContain('Flatpak')
      expect(source).toContain(
        'Motrix-Native-Host-2.0.0-beta.12-linux-<arch>.tar.gz'
      )
      expect(source).toContain('SmartScreen')
      expect(source).toContain(
        'docker.io/motrixapp/motrix-server:2.0.0-beta.12'
      )
      expect(source).toContain('ghcr.io/agalwood/motrix-server:2.0.0-beta.12')
      expect(source).not.toMatch(restrictedPublicLanguage)
      expect(source).not.toMatch(secretLikeIdentifier)
    }
    expect(metainfo).toContain(
      '<release version="2.0.0-beta.12" date="2026-08-16">'
    )
    expect(normalizedBeta12Metainfo).toContain(
      'All five desktop builds, all three Finalize jobs, assembly, the GitHub prerelease, and the R2 update feed completed'
    )
    expect(normalizedBeta12Metainfo).toContain(
      'Immutable amd64/arm64 Server images were published to Docker Hub and GHCR'
    )
    expect(normalizedBeta12Metainfo).toContain(
      'The overall workflow remained unsuccessful because its final anonymous provenance check expected an obsolete builder URL'
    )
    expect(beta12Metainfo).not.toMatch(restrictedPublicLanguage)
    expect(beta12Metainfo).not.toMatch(secretLikeIdentifier)
  })

  it('ships beta.17 Docker Hub metadata recovery without weakening native gates', () => {
    const english = read('docs/release-notes/2.0.0-beta.17.md')
    const chinese = read('docs/release-notes/2.0.0-beta.17.zh-CN.md')
    const normalizedEnglish = english
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const normalizedChinese = chinese
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const metainfo = read('flatpak/app.motrix.native.metainfo.xml')
    const beta17Metainfo =
      /<release version="2\.0\.0-beta\.17"[\s\S]*?<\/release>/.exec(
        metainfo
      )?.[0] ?? ''
    const normalizedBeta17Metainfo = beta17Metainfo.replace(/\s+/g, ' ')

    expect(normalizedEnglish).toContain(
      'Removes Docker Hub repository-description mutation from the release workflow'
    )
    expect(normalizedEnglish).toContain(
      'anonymous signature verification the final step of the single container finalize job'
    )
    expect(normalizedEnglish).toContain(
      'rejects the removed Docker Hub login route, repository-description payload, or description step'
    )
    expect(normalizedEnglish).toContain(
      'does not use `continue-on-error`, does not weaken an artifact, signature, provenance, SBOM, platform, anonymous-pull, or runtime check'
    )
    expect(normalizedEnglish).toContain(
      'Builds `linux/amd64` on `ubuntu-22.04` and `linux/arm64` on `ubuntu-22.04-arm`'
    )
    expect(normalizedEnglish).toContain(
      'The container release path does not install or invoke QEMU'
    )
    expect(normalizedEnglish).toContain(
      'A single architecture never receives the public version tag and cannot become the official release by itself'
    )
    expect(normalizedEnglish).toContain(
      'a rerun resumes an identical complete result or repairs one missing registry'
    )
    expect(normalizedEnglish).toContain(
      'Advances stable floating aliases only in the last recovery-safe job after every build, index, signature, provenance, SBOM, anonymous pull, and runtime gate passes'
    )
    expect(normalizedEnglish).toContain(
      'this release does not claim cross-channel atomicity'
    )
    expect(normalizedChinese).toContain(
      '从发布 workflow 中移除 Docker Hub 仓库描述修改'
    )
    expect(normalizedChinese).toContain(
      '把匿名签名验证作为唯一容器 finalize job 的最后一步'
    )
    expect(normalizedChinese).toContain(
      '本次修改不使用 `continue-on-error`，不削弱 artifact、 签名、provenance、SBOM、platform、匿名拉取或 runtime 检查'
    )
    expect(normalizedChinese).toContain('容器发布路径不安装或调用 QEMU')
    expect(normalizedChinese).toMatch(
      /全部构建、index、签名、\s*provenance、SBOM、匿名拉取和 runtime 门禁通过/u
    )
    expect(normalizedChinese).toMatch(/本版本不宣称跨渠道原子性/u)
    for (const source of [english, chinese]) {
      expect(source).toContain('v2.0.0-beta.16')
      expect(source).toContain('Snap')
      expect(source).toContain('latest/edge')
      expect(source).toContain('AppImage')
      expect(source).toContain('Flatpak')
      expect(source).toContain(
        'Motrix-Native-Host-2.0.0-beta.17-linux-<arch>.tar.gz'
      )
      expect(source).toContain('SmartScreen')
      expect(source).toContain(
        'docker.io/motrixapp/motrix-server:2.0.0-beta.17'
      )
      expect(source).toContain('ghcr.io/agalwood/motrix-server:2.0.0-beta.17')
      expect(source).not.toMatch(restrictedPublicLanguage)
      expect(source).not.toMatch(secretLikeIdentifier)
    }
    expect(normalizedBeta17Metainfo).toContain(
      'Docker Hub repository-description mutation is no longer part of the artifact release authority'
    )
    expect(normalizedBeta17Metainfo).toContain(
      'hands the verified digest directly to the native public runtime matrix'
    )
    expect(beta17Metainfo).not.toMatch(restrictedPublicLanguage)
    expect(beta17Metainfo).not.toMatch(secretLikeIdentifier)
  })

  it('records beta.16 signed indexes and incomplete final runtime matrix', () => {
    const english = read('docs/release-notes/2.0.0-beta.16.md')
    const chinese = read('docs/release-notes/2.0.0-beta.16.zh-CN.md')
    const normalizedEnglish = english
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const normalizedChinese = chinese
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const metainfo = read('flatpak/app.motrix.native.metainfo.xml')
    const beta16Metainfo =
      /<release version="2\.0\.0-beta\.16"[\s\S]*?<\/release>/.exec(
        metainfo
      )?.[0] ?? ''
    const normalizedBeta16Metainfo = beta16Metainfo.replace(/\s+/g, ' ')

    expect(normalizedEnglish).toContain(
      'Motrix 2.0.0-beta.16 was partially distributed'
    )
    expect(normalizedEnglish).toContain(
      'all five desktop builds, all three Finalize jobs, assembly, the GitHub prerelease, and the R2 update feed completed successfully'
    )
    expect(normalizedEnglish).toContain(
      'Each job anonymously pulled its exact staged digest from Docker Hub and GHCR, passed the complete Server runtime smoke in both registries'
    )
    expect(normalizedEnglish).toContain(
      'created the two immutable multi-platform indexes'
    )
    expect(normalizedEnglish).toContain('anonymously verified both signatures')
    expect(normalizedEnglish).toContain(
      'sha256:0430288a5b97f33bacf59a9ffc1634d98835c71e7af4aaced179409aaf5d395a'
    )
    expect(normalizedEnglish).toContain(
      'update the Docker Hub repository description returned HTTP 403'
    )
    expect(normalizedEnglish).toContain(
      'the final native public runtime matrix did not run'
    )
    expect(normalizedEnglish).toContain(
      'The beta.16 container index is public and signed, but the release did not complete every final container gate'
    )
    expect(normalizedEnglish).toContain(
      'must not be described as atomic across distribution channels'
    )
    expect(normalizedChinese).toContain(
      'Motrix 2.0.0-beta.16 于 2026-08-16 完成了部分渠道分发'
    )
    expect(normalizedChinese).toContain('创建两个不可变 multi-platform index')
    expect(normalizedChinese).toContain('仓库描述更新 请求返回 HTTP 403')
    expect(normalizedChinese).toContain('最终原生 公开 runtime matrix 未运行')
    expect(normalizedChinese).toContain(
      'beta.16 容器 index 已公开并签名，但该版本没有完成全部最终容器门禁'
    )
    expect(normalizedChinese).toContain(
      '不能把这个部分完成的结果描述为跨分发渠道的原子发布'
    )
    for (const source of [english, chinese]) {
      expect(source).toContain('31942836854')
      expect(source).toContain('v2.0.0-beta.17')
      expect(source).toContain('Snap')
      expect(source).toContain('latest/edge')
      expect(source).toContain('AppImage')
      expect(source).toContain('Flatpak')
      expect(source).toContain(
        'Motrix-Native-Host-2.0.0-beta.16-linux-<arch>.tar.gz'
      )
      expect(source).toContain('SmartScreen')
      expect(source).toContain(
        'docker.io/motrixapp/motrix-server:2.0.0-beta.16'
      )
      expect(source).toContain('ghcr.io/agalwood/motrix-server:2.0.0-beta.16')
      expect(source).not.toMatch(restrictedPublicLanguage)
      expect(source).not.toMatch(secretLikeIdentifier)
    }
    expect(normalizedBeta16Metainfo).toContain(
      'matching Docker Hub/GHCR index, provenance, SBOM, and anonymous signature checks completed'
    )
    expect(normalizedBeta16Metainfo).toContain(
      'repository-description request returned HTTP 403, so the final native public runtime matrix was skipped'
    )
    expect(beta16Metainfo).not.toMatch(restrictedPublicLanguage)
    expect(beta16Metainfo).not.toMatch(secretLikeIdentifier)
  })

  it('records beta.15 desktop/feed success and two fail-closed native container checks', () => {
    const english = read('docs/release-notes/2.0.0-beta.15.md')
    const chinese = read('docs/release-notes/2.0.0-beta.15.zh-CN.md')
    const normalizedEnglish = english
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const normalizedChinese = chinese
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const metainfo = read('flatpak/app.motrix.native.metainfo.xml')
    const beta15Metainfo =
      /<release version="2\.0\.0-beta\.15"[\s\S]*?<\/release>/.exec(
        metainfo
      )?.[0] ?? ''
    const normalizedBeta15Metainfo = beta15Metainfo.replace(/\s+/g, ' ')

    expect(normalizedEnglish).toContain(
      'Motrix 2.0.0-beta.15 was partially distributed'
    )
    expect(normalizedEnglish).toContain(
      'all five desktop builds, all three Finalize jobs, assembly, the GitHub prerelease, and the R2 update feed completed successfully'
    )
    expect(normalizedEnglish).toContain(
      'The arm64 job anonymously pulled its exact staged digest from both registries and passed the complete Server runtime smoke in each case'
    )
    expect(normalizedEnglish).toContain(
      'Docker Buildx returned the documented flat `.Image` configuration for this single-platform source'
    )
    expect(normalizedEnglish).toContain(
      'Its deterministic local BitTorrent task did not reach `seeding` or `completed` within 180 seconds'
    )
    expect(normalizedEnglish).toContain(
      'Neither registry received an immutable `2.0.0-beta.15` tag or final multi-platform index'
    )
    expect(normalizedEnglish).toContain(
      'No beta.15 index was signed; no final cross-registry provenance, SBOM, or anonymous signature set was verified; and no final public native runtime matrix completed'
    )
    expect(normalizedEnglish).toContain(
      'this result must not be described as atomic across distribution channels'
    )
    expect(normalizedChinese).toContain(
      'Motrix 2.0.0-beta.15 于 2026-08-16 完成了部分渠道分发'
    )
    expect(normalizedChinese).toContain(
      'arm64 job 从两个 registry 匿名拉取精确暂存 digest，并分别通过完整 Server runtime smoke'
    )
    expect(normalizedChinese).toContain(
      '本地确定性 BitTorrent 任务未能在 180 秒内进入 `seeding` 或 `completed`'
    )
    expect(normalizedChinese).toContain(
      '两个 registry 均没有获得不可变 `2.0.0-beta.15` tag 或最终 multi-platform index'
    )
    for (const source of [english, chinese]) {
      expect(source).toContain('31939678223')
      expect(source).toContain('v2.0.0-beta.16')
      expect(source).toContain('Snap')
      expect(source).toContain('latest/edge')
      expect(source).toContain('AppImage')
      expect(source).toContain('Flatpak')
      expect(source).toContain(
        'Motrix-Native-Host-2.0.0-beta.15-linux-<arch>.tar.gz'
      )
      expect(source).toContain('SmartScreen')
      expect(source).toContain(
        'docker.io/motrixapp/motrix-server:2.0.0-beta.15'
      )
      expect(source).toContain('ghcr.io/agalwood/motrix-server:2.0.0-beta.15')
      expect(source).not.toMatch(restrictedPublicLanguage)
      expect(source).not.toMatch(secretLikeIdentifier)
    }
    expect(normalizedBeta15Metainfo).toContain(
      'Both arm64 registry smokes passed before metadata validation rejected Docker Buildx'
    )
    expect(normalizedBeta15Metainfo).toContain(
      'No beta.15 container tag or final index was published or signed, and stable aliases remained unchanged'
    )
    expect(beta15Metainfo).not.toMatch(restrictedPublicLanguage)
    expect(beta15Metainfo).not.toMatch(secretLikeIdentifier)
  })

  it('records beta.14 desktop/feed success and fail-closed native container smoke', () => {
    const english = read('docs/release-notes/2.0.0-beta.14.md')
    const chinese = read('docs/release-notes/2.0.0-beta.14.zh-CN.md')
    const normalizedEnglish = english
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const normalizedChinese = chinese
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const metainfo = read('flatpak/app.motrix.native.metainfo.xml')
    const beta14Metainfo =
      /<release version="2\.0\.0-beta\.14"[\s\S]*?<\/release>/.exec(
        metainfo
      )?.[0] ?? ''
    const normalizedBeta14Metainfo = beta14Metainfo.replace(/\s+/g, ' ')

    expect(normalizedEnglish).toContain('was partially distributed')
    expect(normalizedEnglish).toContain(
      'all five desktop builds, all three Finalize jobs, assembly, the GitHub prerelease, and the R2 update feed completed successfully'
    )
    expect(normalizedEnglish).toContain(
      'Both jobs verified their native GitHub-hosted runner, built without QEMU, and pushed their untagged content-addressed platform digest to Docker Hub and GHCR'
    )
    expect(normalizedEnglish).toContain(
      'The GitHub runner Docker clients rejected `docker image inspect --platform` with `unknown flag: --platform`'
    )
    expect(normalizedEnglish).toContain(
      "The failure was in the smoke client's Docker CLI compatibility, not in an emulated build or a Server-process crash"
    )
    expect(normalizedEnglish).toContain(
      'Neither registry received an immutable `2.0.0-beta.14` tag or final multi-platform index'
    )
    expect(normalizedEnglish).toContain(
      'No beta.14 container index was signed, no final provenance or SBOM set was publicly verified, and no final public native runtime smoke completed'
    )
    expect(normalizedEnglish).toContain(
      'this result must not be described as atomic across distribution channels'
    )
    expect(normalizedChinese).toContain(
      '5 个桌面构建、3 个 Finalize job、assemble、GitHub 预发布版以及 R2 更新数据源 均成功完成'
    )
    expect(normalizedChinese).toContain(
      '两个 job 都在匿名暂存 digest runtime smoke 中 fail-closed'
    )
    expect(normalizedChinese).toContain(
      '两个 registry 均没有获得不可变 `2.0.0-beta.14` tag 或最终 multi-platform index'
    )
    for (const source of [english, chinese]) {
      expect(source).toContain('31937363296')
      expect(source).toContain('unknown flag: --platform')
      expect(source).toContain('v2.0.0-beta.15')
      expect(source).toContain('Snap')
      expect(source).toContain('latest/edge')
      expect(source).toContain('AppImage')
      expect(source).toContain('Flatpak')
      expect(source).toContain(
        'Motrix-Native-Host-2.0.0-beta.14-linux-<arch>.tar.gz'
      )
      expect(source).toContain('SmartScreen')
      expect(source).toContain(
        'docker.io/motrixapp/motrix-server:2.0.0-beta.14'
      )
      expect(source).toContain('ghcr.io/agalwood/motrix-server:2.0.0-beta.14')
      expect(source).not.toMatch(restrictedPublicLanguage)
      expect(source).not.toMatch(secretLikeIdentifier)
    }
    expect(normalizedBeta14Metainfo).toContain(
      'The GitHub prerelease and R2 update feed completed'
    )
    expect(normalizedBeta14Metainfo).toContain(
      'No beta.14 container tag, final index, signature, public provenance or SBOM verification, or final runtime smoke completed'
    )
    expect(beta14Metainfo).not.toMatch(restrictedPublicLanguage)
    expect(beta14Metainfo).not.toMatch(secretLikeIdentifier)
  })

  it('records beta.13 desktop/feed success and incomplete container publication', () => {
    const english = read('docs/release-notes/2.0.0-beta.13.md')
    const chinese = read('docs/release-notes/2.0.0-beta.13.zh-CN.md')
    const normalizedEnglish = english
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const normalizedChinese = chinese
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const metainfo = read('flatpak/app.motrix.native.metainfo.xml')
    const beta13Metainfo =
      /<release version="2\.0\.0-beta\.13"[\s\S]*?<\/release>/.exec(
        metainfo
      )?.[0] ?? ''
    const normalizedBeta13Metainfo = beta13Metainfo.replace(/\s+/g, ' ')

    expect(normalizedEnglish).toContain(
      'Motrix 2.0.0-beta.13 was partially distributed'
    )
    expect(normalizedEnglish).toContain(
      'all five desktop builds, all three Finalize jobs, assembly, the GitHub prerelease, and the R2 update feed completed successfully'
    )
    expect(normalizedEnglish).toContain(
      'At 57.27 seconds in the ARM `pnpm install` layer, QEMU exited with target signal 4'
    )
    expect(normalizedEnglish).toContain('canceled about 33 minutes later')
    expect(normalizedEnglish).toContain(
      'neither immutable beta.13 tag was published, no final index was signed'
    )
    expect(normalizedEnglish).toContain(
      'this result must not be described as atomic across distribution channels'
    )
    expect(normalizedEnglish).toContain(
      'The `v2.0.0-beta.13` tag remains immutable and is not moved or reused'
    )
    expect(normalizedChinese).toContain(
      'Motrix 2.0.0-beta.13 完成了部分渠道分发'
    )
    expect(normalizedChinese).toContain(
      '5 个桌面构建、3 个 Finalize job、assemble、GitHub 预发布版以及 R2 更新数据源 均成功完成'
    )
    expect(normalizedChinese).toContain(
      'ARM `pnpm install` 层运行到 57.27 秒时，QEMU 因目标 signal 4'
    )
    expect(normalizedChinese).toContain('约 33 分钟后容器 job 被取消')
    expect(normalizedChinese).toContain(
      '不能把该结果描述为跨分发渠道的原子发布'
    )
    for (const source of [english, chinese]) {
      const normalizedSource = source
        .replace(/^>\s?/gm, '')
        .replace(/\s+/g, ' ')
      expect(normalizedSource).toContain('v2.0.0-beta.14')
      expect(normalizedSource).toContain('31932206203')
      expect(normalizedSource).toContain('QEMU')
      expect(normalizedSource).toContain('Illegal instruction')
      expect(normalizedSource).toContain('Snap')
      expect(normalizedSource).toContain('latest/edge')
      expect(normalizedSource).toContain('AppImage')
      expect(normalizedSource).toContain('Flatpak')
      expect(normalizedSource).toContain(
        'Motrix-Native-Host-2.0.0-beta.13-linux-<arch>.tar.gz'
      )
      expect(normalizedSource).toContain('SmartScreen')
      expect(normalizedSource).toContain(
        'docker.io/motrixapp/motrix-server:2.0.0-beta.13'
      )
      expect(normalizedSource).toContain(
        'ghcr.io/agalwood/motrix-server:2.0.0-beta.13'
      )
      expect(source).not.toMatch(restrictedPublicLanguage)
      expect(source).not.toMatch(secretLikeIdentifier)
    }
    expect(metainfo).toContain(
      '<release version="2.0.0-beta.13" date="2026-08-16">'
    )
    expect(normalizedBeta13Metainfo).toContain(
      'All desktop builds, Finalize jobs, assembly, the GitHub prerelease, and the R2 update feed completed'
    )
    expect(normalizedBeta13Metainfo).toContain(
      'no beta.13 container tag, signature, public artifact verification, or runtime smoke completed'
    )
    expect(normalizedBeta13Metainfo).toContain(
      'Windows packages were published unsigned'
    )
    expect(beta13Metainfo).not.toMatch(restrictedPublicLanguage)
    expect(beta13Metainfo).not.toMatch(secretLikeIdentifier)
  })

  it('preserves beta.6 Snap recovery and canceled release history', () => {
    const english = read('docs/release-notes/2.0.0-beta.6.md')
    const chinese = read('docs/release-notes/2.0.0-beta.6.zh-CN.md')
    const normalizedEnglish = english
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const normalizedChinese = chinese
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')

    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.6/docs/release-notes/2.0.0-beta.5.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.6/docs/release-notes/2.0.0-beta.5.zh-CN.md'
    )
    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.7/docs/release-notes/2.0.0-beta.6.zh-CN.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.7/docs/release-notes/2.0.0-beta.6.md'
    )
    expect(normalizedEnglish).toContain(
      'Prepares the isolated `publish-edge` runner immediately after checkout and before Snap artifact download or verification'
    )
    expect(normalizedEnglish).toContain('SHA-pinned setup actions')
    expect(normalizedEnglish).toContain(
      'installs the complete lockfile-pinned workspace dependency closure'
    )
    expect(normalizedEnglish).toContain(
      'ahead of all Store credential access and mutation'
    )
    expect(normalizedEnglish).toContain(
      'Store uploads still do not release automatically'
    )
    expect(normalizedEnglish).toContain(
      'only the exact revisions returned by successful uploads may enter `latest/edge`, followed by rollback handling, public channel verification, and preservation of the trusted revision record'
    )
    expect(normalizedEnglish).toContain(
      'Protected-tag and environment gates remain unchanged, and build jobs still receive no Store secrets'
    )
    expect(normalizedChinese).toContain(
      '在 checkout 后、下载或验证 Snap artifact 前准备隔离的 `publish-edge` runner'
    )
    expect(normalizedChinese).toContain('使用固定 SHA 的 setup action')
    expect(normalizedChinese).toContain(
      '安装 lockfile 固定的完整 workspace dependency closure'
    )
    expect(normalizedChinese).toContain(
      '在任何 Store credential 访问和 mutation 前验证两个架构 artifact'
    )
    expect(normalizedChinese).toContain('Store upload 仍不会自动 release')
    expect(normalizedChinese).toContain(
      '只有上传成功后返回的精确 revision 才能进入 `latest/edge`，随后执行 rollback 处理、公开 channel 验证， 并保存可信 revision record'
    )
    expect(normalizedChinese).toContain(
      '受保护 tag 和 environment gate 保持不变，build job 仍不会获得 Store secret'
    )
    expect(normalizedEnglish).toContain('All five desktop build jobs')
    expect(normalizedEnglish).toContain(
      'both macOS finalization jobs were canceled without running'
    )
    expect(normalizedEnglish).toContain(
      'unsigned Windows mode selection all succeeded'
    )
    expect(normalizedEnglish).toContain(
      '`.../releases/download//nsis-3.0.4.1.7z`, which returned HTTP 404'
    )
    expect(normalizedEnglish).toContain(
      'The failure was unrelated to absent Authenticode credentials'
    )
    expect(normalizedEnglish).toContain(
      'Assemble, GitHub Release, R2 update-feed publishing, and Docker Hub/GHCR container publishing were canceled without running'
    )
    expect(normalizedEnglish).toContain(
      'the amd64 transfer completed and entered Store processing before the job was canceled'
    )
    expect(normalizedEnglish).toContain(
      'successfully built, verified, and uploaded the internal GitHub Actions artifacts for both `amd64` and `arm64`'
    )
    expect(normalizedEnglish).toContain(
      'verified the complete `amd64`/`arm64` set, and validated the scoped Store credential'
    )
    expect(normalizedEnglish).toContain(
      'no exact revision was returned or recorded'
    )
    expect(normalizedEnglish).toContain('the arm64 Store upload never started')
    expect(normalizedEnglish).toContain(
      'Public `latest/edge` remained on amd64 Motrix 1.8.19 revision 49'
    )
    expect(normalizedEnglish).toContain(
      'At most one unchannelled internal amd64 revision may have completed processing after cancellation'
    )
    expect(normalizedEnglish).toContain(
      'no beta.6 Snap revision was released to a channel'
    )
    expect(normalizedEnglish).toContain('external distribution remained zero')
    expect(normalizedChinese).toContain('5 个桌面构建 job')
    expect(normalizedChinese).toContain(
      '两个 macOS finalize job 均未执行而被取消'
    )
    expect(normalizedChinese).toContain('未签名 Windows 模式选择均已成功')
    expect(normalizedChinese).toContain(
      '`.../releases/download//nsis-3.0.4.1.7z`，并收到 HTTP 404'
    )
    expect(normalizedChinese).toContain(
      '该失败与缺少 Authenticode credential 无关'
    )
    expect(normalizedChinese).toContain(
      'assemble、GitHub Release、R2 更新数据源发布以及 Docker Hub/GHCR container publish 均未执行而被取消'
    )
    expect(normalizedChinese).toContain(
      'amd64 传输完成并进入 Store processing，此时 job 被取消'
    )
    expect(normalizedChinese).toContain(
      '成功构建、验证和上传 `amd64`、`arm64` 两个架构的内部 GitHub Actions artifact'
    )
    expect(normalizedChinese).toContain(
      '验证了完整的双架构集合，并通过了限定范围的 Store credential 校验'
    )
    expect(normalizedChinese).toContain('流程没有返回或记录精确 revision')
    expect(normalizedChinese).toContain('arm64 Store upload 从未开始')
    expect(normalizedChinese).toContain(
      '公开 `latest/edge` 仍是 amd64 Motrix 1.8.19 revision 49'
    )
    expect(normalizedChinese).toContain(
      '取消后最多可能有 1 个未上 channel 的内部 amd64 revision 完成 processing'
    )
    expect(normalizedChinese).toContain(
      '没有 beta.6 Snap revision 被发布到任何 channel'
    )
    expect(normalizedChinese).toContain('外部分发为零')
    for (const source of [english, chinese]) {
      expect(source).toContain('pnpm `11.21.0`')
      expect(source).toContain('Node.js 24')
      expect(source).toContain(
        'pnpm install --frozen-lockfile --ignore-scripts'
      )
      expect(source).toContain('MOTRIX_SKIP_ELECTRON_REBUILD=1')
      expect(source).toContain('MOTRIX_SKIP_ENGINE_FETCH=1')
      expect(source).toContain('verify-snap-artifact.mjs')
      expect(source).toContain('js-yaml')
      expect(source).toContain('latest/edge')
      expect(source).toContain('AppImage')
      expect(source).toContain('Flatpak')
      expect(source).toContain('Authenticode')
      expect(source).toContain('SmartScreen')
    }
  })

  it('marks beta.5 as an unpublished attempt superseded by beta.6', () => {
    const english = read('docs/release-notes/2.0.0-beta.5.md')
    const chinese = read('docs/release-notes/2.0.0-beta.5.zh-CN.md')
    const normalizedEnglish = english
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')
    const normalizedChinese = chinese
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ')

    expect(english).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.6/docs/release-notes/2.0.0-beta.5.zh-CN.md'
    )
    expect(chinese).toContain(
      'https://github.com/agalwood/Motrix/blob/v2.0.0-beta.6/docs/release-notes/2.0.0-beta.5.md'
    )
    expect(english).toContain('This release attempt did not complete')
    expect(normalizedEnglish).toContain('All five desktop build jobs')
    expect(normalizedEnglish).toContain(
      'macOS signing environments remained pending approval'
    )
    expect(normalizedEnglish).toContain('neither macOS finalization job ran')
    expect(normalizedEnglish).toContain(
      'unsigned Windows finalization job was canceled while it was in progress'
    )
    expect(normalizedEnglish).toContain(
      'Assemble, GitHub Release, R2 update-feed publishing, and Docker Hub/GHCR container publishing were canceled before they ran'
    )
    expect(normalizedEnglish).toContain(
      'successfully built, verified, and uploaded the internal GitHub Actions artifacts for both `amd64` and `arm64`'
    )
    expect(normalizedEnglish).toContain(
      'happened before Store credential validation, Store upload, exact revision binding, `latest/edge` release, public channel verification, or revision record preservation'
    )
    expect(normalizedEnglish).toContain('external distribution remained zero')
    expect(chinese).toContain('本次发布尝试未完成')
    expect(normalizedChinese).toContain('5 个桌面构建 job')
    expect(normalizedChinese).toContain('macOS 签名环境一直等待审批')
    expect(normalizedChinese).toContain('两个 macOS finalize job 均未执行')
    expect(normalizedChinese).toContain(
      '未签名 Windows finalize job 在运行过程中取消'
    )
    expect(normalizedChinese).toContain(
      'assemble、GitHub Release、R2 更新数据源 发布以及 Docker Hub/GHCR container publish 均在执行前取消'
    )
    expect(normalizedChinese).toContain(
      '成功构建、验证和上传 `amd64`、`arm64` 两个架构的内部 GitHub Actions artifact'
    )
    expect(normalizedChinese).toContain(
      '失败发生在 Store credential validation、Store upload、精确 revision 绑定、`latest/edge` release、public channel verification 和 revision record preservation 之前'
    )
    expect(normalizedChinese).toContain('外部分发为零')
    for (const source of [english, chinese]) {
      expect(source).toContain('v2.0.0-beta.6')
      expect(source).toMatch(/assemble/i)
      expect(source).toContain('GitHub Release')
      expect(source).toContain('R2')
      expect(source).toContain('Docker Hub')
      expect(source).toContain('GHCR')
      expect(source).toContain('Snap')
      expect(source).toContain('publish-edge')
      expect(source).toContain('Verify complete upload set')
      expect(source).toContain('ERR_MODULE_NOT_FOUND')
      expect(source).toContain('js-yaml')
      expect(source).toContain('AppImage')
      expect(source).toContain('Flatpak')
      expect(source).toContain('Authenticode')
      expect(source).toContain('SmartScreen')
    }
    expect(english).toContain('Intended downloads (not published)')
    expect(chinese).toContain('原计划下载（未发布）')
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
