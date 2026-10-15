import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentRuntime } from '@/content/ContentRuntime'

declare const browser: {
  runtime: {
    sendMessage: (msg: unknown) => Promise<unknown>
    onMessage: {
      addListener: (
        fn: (
          msg: unknown,
          sender: unknown,
          sendResponse: (r: unknown) => void
        ) => boolean
      ) => void
    }
  }
}

let listener:
  | ((
      msg: unknown,
      sender: unknown,
      sendResponse: (r: unknown) => void
    ) => boolean)
  | null = null

beforeEach(() => {
  listener = null
  browser.runtime.onMessage = {
    addListener: vi.fn((fn) => {
      listener = fn
    }),
  }
})

describe('ContentRuntime', () => {
  it('selects YouTube adapter on youtube.com', () => {
    const rt = new ContentRuntime('https://www.youtube.com/watch?v=abc12345678')
    expect(rt.adapterId).toBe('youtube')
  })

  it('returns null adapter for unsupported sites', () => {
    const rt = new ContentRuntime('https://random.example.com')
    expect(rt.adapterId).toBeNull()
  })

  it('announces to background on bootstrap with tabUrl', async () => {
    browser.runtime.sendMessage = vi.fn().mockResolvedValue({ ok: true })
    const rt = new ContentRuntime('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    await rt.bootstrap()
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      kind: 'bg.adapterAnnounce',
      payload: {
        adapterId: 'youtube',
        tabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      },
    })
  })

  it('skips announce when no adapter matches', async () => {
    browser.runtime.sendMessage = vi.fn().mockResolvedValue({ ok: true })
    const rt = new ContentRuntime('https://example.com')
    await rt.bootstrap()
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('handles content.resolve by delegating to adapter', async () => {
    const rt = new ContentRuntime('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    rt.attach()

    const response = await new Promise<unknown>((resolve) => {
      if (!listener) throw new Error('listener not attached')
      listener(
        {
          kind: 'content.resolve',
          payload: {
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          },
        },
        {},
        resolve
      )
    })
    const result = response as {
      selections: unknown[]
      meta: { title: string }
    }
    expect(result.selections).toBeInstanceOf(Array)
    expect(result.meta.title).toContain('placeholder')
  })

  it('ignores non-content.resolve envelopes', () => {
    const rt = new ContentRuntime('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    rt.attach()
    if (!listener) throw new Error('listener not attached')
    const handled = listener({ kind: 'other.thing', payload: {} }, {}, () => {})
    expect(handled).toBe(false)
  })
})
