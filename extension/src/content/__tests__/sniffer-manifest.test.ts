import { describe, expect, it } from 'vitest'
import manifestConfig from '#manifest-config'

type ContentScript = {
  matches?: string[]
  js?: string[]
  run_at?: string
  all_frames?: boolean
  world?: string
}

async function contentScripts(mode: string): Promise<ContentScript[]> {
  const manifest = (await manifestConfig({ command: 'build', mode })) as {
    content_scripts?: ContentScript[]
  }
  return manifest.content_scripts ?? []
}

describe('continuous generic sniffer manifest matrix', () => {
  it('starts Chromium relay and MAIN collector in every frame at document_start', async () => {
    const scripts = await contentScripts('chromium')
    const relay = scripts.find((script) =>
      script.js?.includes('src/content/sniffer-relay.ts')
    )
    const collector = scripts.find((script) =>
      script.js?.includes('src/content/sniffer-entry.ts')
    )

    expect(relay).toMatchObject({
      run_at: 'document_start',
      all_frames: true,
      world: 'ISOLATED',
    })
    expect(collector).toMatchObject({
      run_at: 'document_start',
      all_frames: true,
      world: 'MAIN',
    })
    expect(relay).not.toHaveProperty('match_about_blank')
    expect(collector).not.toHaveProperty('match_about_blank')
  })

  it('uses Firefox MAIN collection plus an isolated relay in every frame', async () => {
    const generated = (await manifestConfig({
      command: 'build',
      mode: 'firefox',
    })) as {
      content_scripts?: ContentScript[]
      browser_specific_settings?: {
        gecko?: { strict_min_version?: string }
        gecko_android?: { strict_min_version?: string }
      }
    }
    const scripts = generated.content_scripts ?? []
    const relay = scripts.find((script) =>
      script.js?.includes('src/content/sniffer-relay.ts')
    )
    const collector = scripts.find((script) =>
      script.js?.includes('src/content/sniffer-entry.ts')
    )

    expect(relay).toMatchObject({
      run_at: 'document_start',
      all_frames: true,
      world: 'ISOLATED',
    })
    expect(collector).toMatchObject({
      run_at: 'document_start',
      all_frames: true,
      world: 'MAIN',
    })
    expect(relay).not.toHaveProperty('match_about_blank')
    expect(collector).not.toHaveProperty('match_about_blank')
    expect(generated.browser_specific_settings?.gecko?.strict_min_version).toBe(
      '142.0'
    )
    expect(
      generated.browser_specific_settings?.gecko_android?.strict_min_version
    ).toBe('142.0')
    expect(
      scripts.some((script) => script.js?.includes('src/content/index.ts'))
    ).toBe(false)
    expect(JSON.stringify(scripts)).not.toMatch(/youtube\.com|youtu\.be/i)
  })

  it('keeps generic collection in Web Store builds without declaring YouTube hosts', async () => {
    const scripts = await contentScripts('webstore')
    expect(
      scripts.some((script) =>
        script.js?.includes('src/content/sniffer-entry.ts')
      )
    ).toBe(true)
    expect(
      scripts.some((script) => script.js?.includes('src/content/index.ts'))
    ).toBe(false)
    expect(JSON.stringify(scripts)).not.toMatch(/youtube\.com|youtu\.be/i)
  })
})
