import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  contextMenuTitle,
  downloadHttpInBrowser,
  handleMenuClick,
  handleMenuClickSafely,
  MENU_ID,
  registerContextMenu,
  updateContextMenuTitle,
} from '@/background/contextMenu/register'
import { type Browser, extensionBrowser } from '@/shared/browser'
import { i18n } from '@/shared/i18n'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

describe('handleMenuClick', () => {
  beforeEach(() => {
    // confirmSensitive default true is fine; sensitive list won't match example.com
  })

  it('on a link click, runs handoff via the injected runner with origin=context-menu', async () => {
    const runs: { url: string; pageUrl: string; origin: string }[] = []
    await handleMenuClick(
      {
        linkUrl: 'https://cdn.example.com/a.bin',
        pageUrl: 'https://example.com/p',
      } as Browser.contextMenus.OnClickData,
      { title: 'Example' } as Browser.tabs.Tab,
      {
        getConfig: async () => ({
          ...TAKEOVER_DEFAULT,
          enabled: true,
          consentAckVersion: 1,
        }),
        run: async (target) => {
          runs.push({
            url: target.url,
            pageUrl: target.pageUrl,
            origin: target.origin,
          })
        },
      }
    )
    expect(runs).toEqual([
      {
        url: 'https://cdn.example.com/a.bin',
        pageUrl: 'https://example.com/p',
        origin: 'context-menu',
      },
    ])
  })

  it('skips non-http(s) targets', async () => {
    const runs: unknown[] = []
    await handleMenuClick(
      {
        srcUrl: 'data:image/png;base64,AAAA',
        pageUrl: 'https://example.com',
      } as Browser.contextMenus.OnClickData,
      undefined,
      {
        getConfig: async () => ({ ...TAKEOVER_DEFAULT, enabled: true }),
        run: async () => void runs.push(1),
      }
    )
    expect(runs).toEqual([])
  })

  it('on a magnet link click, runs handoff with the magnet uri + dn filename', async () => {
    const runs: { url: string; origin: string; suggestedFilename: string }[] =
      []
    await handleMenuClick(
      {
        linkUrl: 'magnet:?xt=urn:btih:abc&dn=Cool+File',
        pageUrl: 'https://example.com/p',
      } as Browser.contextMenus.OnClickData,
      { title: 'Example' } as Browser.tabs.Tab,
      {
        getConfig: async () => ({ ...TAKEOVER_DEFAULT, enabled: true }),
        run: async (t) =>
          void runs.push({
            url: t.url,
            origin: t.origin,
            suggestedFilename: t.suggestedFilename,
          }),
      }
    )
    expect(runs).toEqual([
      {
        url: 'magnet:?xt=urn:btih:abc&dn=Cool+File',
        origin: 'context-menu',
        suggestedFilename: 'Cool File',
      },
    ])
  })

  it('contains a rejected startup or handoff dependency for event listeners', async () => {
    await expect(
      handleMenuClickSafely(
        {
          linkUrl: 'https://private.example/download',
          pageUrl: 'https://private.example/page',
        } as Browser.contextMenus.OnClickData,
        undefined,
        {
          getConfig: async () => TAKEOVER_DEFAULT,
          run: async () => {
            throw new Error('background startup unavailable: private data')
          },
        }
      )
    ).resolves.toBeUndefined()
  })
})

describe('downloadHttpInBrowser', () => {
  it('passes an HTTP(S) right-click URL to the browser downloads API', async () => {
    const download = vi.fn(async () => 42)

    await downloadHttpInBrowser('https://cdn.example.com/a.bin', download)

    expect(download).toHaveBeenCalledOnce()
    expect(download).toHaveBeenCalledWith({
      url: 'https://cdn.example.com/a.bin',
    })
  })

  it('rejects magnet URIs without invoking the browser downloads API', async () => {
    const download = vi.fn(async () => 42)

    await expect(
      downloadHttpInBrowser('magnet:?xt=urn:btih:abc', download)
    ).rejects.toThrow(/HTTP\(S\)/)
    expect(download).not.toHaveBeenCalled()
  })
})

describe('contextMenuTitle', () => {
  it('paired → "Download with Motrix" (en) / "用 Motrix 下载" (zh)', async () => {
    await i18n.changeLanguage('en-US')
    expect(contextMenuTitle(true, i18n.t)).toBe('Download with Motrix')
    await i18n.changeLanguage('zh-CN')
    expect(contextMenuTitle(true, i18n.t)).toBe('用 Motrix 下载')
  })
  it('unpaired → "Pair Motrix, then download" (en) / localized (zh)', async () => {
    await i18n.changeLanguage('en-US')
    expect(contextMenuTitle(false, i18n.t)).toBe('Pair Motrix, then download')
    await i18n.changeLanguage('zh-CN')
    expect(contextMenuTitle(false, i18n.t)).toBe('先配对 Motrix，再下载')
  })
})

describe('updateContextMenuTitle', () => {
  beforeEach(() => {
    Object.assign(extensionBrowser, {
      contextMenus: {
        update: vi.fn(),
        create: vi.fn(),
        removeAll: vi.fn(async () => {}),
        onClicked: { addListener: vi.fn() },
      },
    })
  })
  it('keeps the menu alive during background wake and attaches its click listener immediately', async () => {
    let finishUpdate!: () => void
    const update = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishUpdate = resolve
        })
    )
    Object.assign(extensionBrowser.contextMenus, { update })
    const run = vi.fn(async () => {})
    registerContextMenu({ run, getConfig: async () => TAKEOVER_DEFAULT })
    const listener = vi.mocked(
      extensionBrowser.contextMenus.onClicked.addListener
    ).mock.calls[0]![0]
    listener(
      {
        menuItemId: MENU_ID,
        linkUrl: 'https://example.com/download',
      } as Browser.contextMenus.OnClickData,
      { windowId: 7 } as Browser.tabs.Tab
    )
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'context-menu' }),
        7
      )
    )
    expect(extensionBrowser.contextMenus.removeAll).not.toHaveBeenCalled()
    expect(extensionBrowser.contextMenus.create).not.toHaveBeenCalled()
    finishUpdate()
  })
  it('creates the item when no persisted menu exists', async () => {
    Object.assign(extensionBrowser.contextMenus, {
      update: vi.fn(async () => {
        throw new Error('missing item')
      }),
    })
    registerContextMenu({
      run: vi.fn(),
      getConfig: async () => TAKEOVER_DEFAULT,
    })
    await vi.waitFor(() =>
      expect(extensionBrowser.contextMenus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: MENU_ID,
          contexts: ['link', 'image', 'video', 'audio'],
        })
      )
    )
  })
  it('updates the menu item with the paired title', async () => {
    await i18n.changeLanguage('en-US')
    const update = vi.fn(async () => {})
    Object.assign(extensionBrowser, {
      contextMenus: { update },
    })
    updateContextMenuTitle(true)
    expect(update).toHaveBeenCalledWith(MENU_ID, {
      title: 'Download with Motrix',
    })
  })
})

it('preserves the source window for HTTP and magnet confirmations', async () => {
  for (const linkUrl of [
    'https://example.com/once.zip',
    'magnet:?xt=urn:btih:abc',
  ]) {
    const run = vi.fn(async () => {})
    await handleMenuClick(
      { linkUrl } as Browser.contextMenus.OnClickData,
      { windowId: 17 } as Browser.tabs.Tab,
      { run, getConfig: async () => TAKEOVER_DEFAULT }
    )
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ url: linkUrl }),
      17
    )
  }
})
