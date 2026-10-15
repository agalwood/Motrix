import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/background/MessageBus', () => ({ send: vi.fn() }))
vi.mock('@/popup/imagePreview', () => ({ loadImagePreview: vi.fn() }))

import * as MessageBus from '@/background/MessageBus'
import * as ImagePreview from '@/popup/imagePreview'
import { MediaPanel } from '@/popup/MediaPanel'
import { i18n } from '@/shared/i18n'
import { mediaStorageKey } from '@/shared/media'

const send = vi.mocked(MessageBus.send)
const loadImagePreview = vi.mocked(ImagePreview.loadImagePreview)
const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL')
const tabsQuery = vi.mocked(
  (globalThis as unknown as { chrome: { tabs: { query: typeof vi.fn } } })
    .chrome.tabs.query
)

const ITEM = {
  kind: 'mux' as const,
  url: 'https://media.example/video.mp4',
  pageUrl: 'https://media.example/watch',
  pageTitle: 'Example video',
  detectedAt: 1,
}

const HLS_ITEM = {
  kind: 'hls' as const,
  url: 'https://media.example/master.m3u8',
  pageUrl: 'https://media.example/watch',
  pageTitle: 'Example stream',
  detectedAt: 2,
}

const IMAGE_ITEM = {
  kind: 'direct' as const,
  url: 'https://images.example/assets/hero.webp',
  pageUrl: 'https://media.example/watch',
  pageTitle: 'Launch hero',
  category: 'image' as const,
  suggestedFilename: 'launch-hero.webp',
  mimeType: 'image/webp',
  width: 1920,
  height: 1080,
  sizeBytes: 438_272,
  alt: 'Launch artwork',
  previewable: true,
  evidence: ['network'],
  detectedAt: 3,
  requestHeaders: { Authorization: 'secret-must-not-render' },
}

const PNG_IMAGE_ITEM = {
  ...IMAGE_ITEM,
  url: 'https://images.example/assets/app-icon.png',
  suggestedFilename: 'app-icon.png',
  mimeType: 'image/png',
  width: 128,
  height: 128,
  sizeBytes: 3_664,
  detectedAt: 7,
}

const JPG_IMAGE_ITEM = {
  ...IMAGE_ITEM,
  url: 'https://images.example/assets/poster.jpg',
  suggestedFilename: 'poster.jpg',
  mimeType: 'image/jpeg',
  width: 1200,
  height: 1800,
  sizeBytes: 1_887_436,
  detectedAt: 8,
}

const SVG_ITEM = {
  ...IMAGE_ITEM,
  url: 'https://images.example/assets/brand.svg?revision=2',
  suggestedFilename: 'brand.svg',
  mimeType: 'image/svg+xml',
  detectedAt: 4,
}

const MUX_PRIMARY = {
  ...ITEM,
  audioUrl: 'https://media.example/audio-primary.m4a',
  suggestedFilename: 'primary-track.mp4',
  detectedAt: 5,
}

const MUX_ALTERNATE = {
  ...ITEM,
  audioUrl: 'https://media.example/audio-alternate.m4a',
  suggestedFilename: 'alternate-track.mp4',
  detectedAt: 6,
}

function mediaTestIdKey(media: Parameters<typeof mediaStorageKey>[0]): string {
  const key = mediaStorageKey(media)
  return key.includes('\u0000') ? `composite-${encodeURIComponent(key)}` : key
}

function submitCalls(): unknown[][] {
  return send.mock.calls.filter(([kind]) => kind === 'bg.submitMedia')
}

describe('MediaPanel resource rows', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
    tabsQuery.mockResolvedValue([])
    send.mockReset()
    loadImagePreview.mockReset()
    loadImagePreview.mockImplementation(
      async (url) => `blob:preview-${encodeURIComponent(url)}`
    )
  })

  it('discovers resources while mounted behind another popup tab', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [ITEM], selectionKinds: ['direct'] }
      }
      return {}
    })

    render(<MediaPanel active={false} connected={false} />)

    expect(
      await screen.findByRole('checkbox', { name: 'Select video.mp4' })
    ).toBeTruthy()
    expect(
      send.mock.calls.filter(([kind]) => kind === 'bg.scanActiveTab')
    ).toHaveLength(1)
  })

  it('uses the shared category classifier for reliable image filtering', async () => {
    const categoryOnlyImage = {
      ...IMAGE_ITEM,
      url: 'https://images.example/render?id=hero',
      suggestedFilename: 'category-cover',
      mimeType: 'application/octet-stream',
    }
    const audio = {
      kind: 'direct' as const,
      url: 'https://media.example/theme.flac',
      pageUrl: 'https://media.example/watch',
      pageTitle: 'Theme',
      mimeType: 'audio/flac',
      detectedAt: 5,
    }
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return {
          media: [audio, categoryOnlyImage, ITEM],
          selectionKinds: ['direct', 'mux'],
        }
      }
      return {}
    })

    render(<MediaPanel active connected />)
    await screen.findByText('category-cover')
    fireEvent.click(screen.getByRole('tab', { name: 'Images' }))

    expect(screen.getByText('category-cover')).toBeTruthy()
    expect(screen.queryByText('theme.flac')).toBeNull()
    expect(screen.queryByText('video.mp4')).toBeNull()
  })

  it('uses compact counts and applies image quick filters without adding another top-level control', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return {
          media: [ITEM, IMAGE_ITEM, PNG_IMAGE_ITEM, JPG_IMAGE_ITEM],
          selectionKinds: ['direct', 'mux'],
        }
      }
      return {}
    })
    const user = userEvent.setup({ pointerEventsCheck: 0 })

    render(<MediaPanel active connected />)
    await screen.findByText('video.mp4')

    expect(screen.getByText('4 items')).toBeTruthy()
    expect(screen.queryByText(/resources found on this page/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Filter' })).toBeNull()

    await user.click(screen.getByRole('tab', { name: 'Images' }))
    expect(screen.getByText('3 images')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Filter' }))
    await user.click(screen.getByRole('button', { name: 'Filter PNG images' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.getByText('app-icon.png')).toBeTruthy()
    expect(screen.queryByText('launch-hero.webp')).toBeNull()
    expect(screen.queryByText('poster.jpg')).toBeNull()
    expect(screen.getByText('1 / 3 images')).toBeTruthy()
  })

  it('selects only filtered images, retains hidden selections, and shows the mixed select-all state', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return {
          media: [IMAGE_ITEM, PNG_IMAGE_ITEM, JPG_IMAGE_ITEM],
          selectionKinds: ['direct'],
        }
      }
      if (kind === 'bg.submitMedia') return { ok: true }
      return {}
    })
    const user = userEvent.setup({ pointerEventsCheck: 0 })

    render(<MediaPanel active connected />)
    await screen.findByText('launch-hero.webp')
    await user.click(screen.getByRole('tab', { name: 'Images' }))
    await user.click(screen.getByRole('button', { name: 'Filter' }))
    await user.click(screen.getByRole('button', { name: 'Filter PNG images' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select all' }))

    expect(screen.getByText('Download 1')).toBeTruthy()
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Select app-icon.png',
        }) as HTMLInputElement
      ).checked
    ).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Filter' }))
    await user.click(screen.getByRole('button', { name: 'Filter PNG images' }))
    await user.click(screen.getByRole('button', { name: 'Filter WEBP images' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.getByText('launch-hero.webp')).toBeTruthy()
    expect(screen.queryByText('app-icon.png')).toBeNull()
    expect(screen.getByText('Download 1')).toBeTruthy()
    await user.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(screen.getByText('Download 2')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Filter' }))
    await user.click(screen.getByRole('button', { name: 'Filter JPG images' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.getByText('launch-hero.webp')).toBeTruthy()
    expect(screen.getByText('poster.jpg')).toBeTruthy()
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Select all',
        }) as HTMLInputElement
      ).indeterminate
    ).toBe(true)
  })

  it('offers a clear action when image dimensions produce no matches', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return {
          media: [IMAGE_ITEM, PNG_IMAGE_ITEM, JPG_IMAGE_ITEM],
          selectionKinds: ['direct'],
        }
      }
      return {}
    })
    const user = userEvent.setup({ pointerEventsCheck: 0 })

    render(<MediaPanel active connected />)
    await screen.findByText('launch-hero.webp')
    await user.click(screen.getByRole('tab', { name: 'Images' }))
    await user.click(screen.getByRole('button', { name: 'Filter' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Width value' }), {
      target: { value: '5000' },
    })
    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.getByText('No matching images')).toBeTruthy()
    expect(screen.getByText('0 / 3 images')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))

    expect(await screen.findByText('launch-hero.webp')).toBeTruthy()
    expect(screen.getByText('3 images')).toBeTruthy()
  })

  it('keeps unrendered image candidates as a fallback without issuing a preview fetch', async () => {
    const lazyCandidate = {
      ...IMAGE_ITEM,
      url: 'https://images.example/assets/lazy-candidate.webp',
      suggestedFilename: 'lazy-candidate.webp',
      evidence: ['img', 'srcset', 'lazy'],
    }
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [lazyCandidate], selectionKinds: ['direct'] }
      }
      return {}
    })

    render(<MediaPanel active connected />)
    await screen.findByText('lazy-candidate.webp')
    const preview = screen.getByTestId(
      `resource-thumbnail-${mediaTestIdKey(lazyCandidate)}`
    )

    expect(preview.getAttribute('data-preview')).toBe('fallback')
    expect(preview.querySelector('img')).toBeNull()
    expect(loadImagePreview).not.toHaveBeenCalled()
  })

  it('uses the bounded credentialless fallback for an image observed as loaded', async () => {
    const renderedImage = {
      ...IMAGE_ITEM,
      url: 'https://images.example/assets/rendered.webp',
      suggestedFilename: 'rendered.webp',
      evidence: ['img', 'current-src'],
    }
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [renderedImage], selectionKinds: ['direct'] }
      }
      if (kind === 'bg.getMediaThumbnail') return { dataUrl: null }
      return {}
    })

    render(<MediaPanel active connected />)
    await screen.findByText('rendered.webp')
    const preview = screen.getByTestId(
      `resource-thumbnail-${mediaTestIdKey(renderedImage)}`
    )

    await waitFor(() =>
      expect(preview.getAttribute('data-preview-source')).toBe('network')
    )
    expect(loadImagePreview).toHaveBeenCalledWith(renderedImage.url, {
      signal: expect.any(AbortSignal),
      width: 72,
      height: 72,
    })
  })

  it('uses an already-rendered page thumbnail before considering a network fetch', async () => {
    const pageOnlyImage = {
      ...IMAGE_ITEM,
      url: 'http://192.168.1.20/assets/nas-cover.webp',
      suggestedFilename: 'nas-cover.webp',
      evidence: ['dom-img'],
    }
    const dataUrl = 'data:image/webp;base64,UklGRg=='
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [pageOnlyImage], selectionKinds: ['direct'] }
      }
      if (kind === 'bg.getMediaThumbnail') return { dataUrl }
      return {}
    })

    render(<MediaPanel active connected />)
    await screen.findByText('nas-cover.webp')
    const preview = screen.getByTestId(
      `resource-thumbnail-${mediaTestIdKey(pageOnlyImage)}`
    )
    await waitFor(() =>
      expect(preview.querySelector('img')?.getAttribute('src')).toBe(dataUrl)
    )

    expect(preview.getAttribute('data-preview-source')).toBe('page')
    expect(send).toHaveBeenCalledWith('bg.getMediaThumbnail', {
      mediaKey: mediaStorageKey(pageOnlyImage),
    })
    expect(loadImagePreview).not.toHaveBeenCalled()
  })

  it('renders a compact lazy image preview with filename, metadata, and an accessible host', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [IMAGE_ITEM], selectionKinds: ['direct'] }
      }
      return {}
    })

    render(<MediaPanel active connected />)
    const name = await screen.findByText('launch-hero.webp')
    const row = name.closest('li')
    if (!row) throw new Error('image resource row missing')
    const preview = within(row).getByTestId(
      `resource-thumbnail-${mediaTestIdKey(IMAGE_ITEM)}`
    )
    await waitFor(() => expect(preview.querySelector('img')).not.toBeNull())
    const image = preview.querySelector('img')

    expect(row.className).toContain('h-[68px]')
    expect(preview.className).toContain('size-11')
    expect(preview.getAttribute('data-preview-source')).toBe('network')
    expect(image?.getAttribute('src')).toBe(
      `blob:preview-${encodeURIComponent(IMAGE_ITEM.url)}`
    )
    expect(document.querySelector(`img[src="${IMAGE_ITEM.url}"]`)).toBeNull()
    expect(image?.getAttribute('loading')).toBe('lazy')
    expect(image?.getAttribute('decoding')).toBe('async')
    expect(loadImagePreview).toHaveBeenCalledWith(IMAGE_ITEM.url, {
      signal: expect.any(AbortSignal),
      width: 72,
      height: 72,
    })
    expect(screen.getByText('WEBP · 1920×1080 · 428 KB')).toBeTruthy()
    expect(within(row).getByText('images.example')).toBeTruthy()
    expect(row.textContent).toContain(
      'images.example · WEBP · 1920×1080 · 428 KB'
    )
    expect(name.getAttribute('title')).toContain('images.example')
    expect(screen.getByText('Source: images.example')).toBeTruthy()
    expect(screen.queryByText('secret-must-not-render')).toBeNull()

    if (!image) throw new Error('preview image missing')
    fireEvent.error(image)
    expect(preview.getAttribute('data-preview')).toBe('fallback')
    expect(preview.querySelector('img')).toBeNull()
  })

  it('revokes the controlled object URL when an image row unmounts', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [IMAGE_ITEM], selectionKinds: ['direct'] }
      }
      return {}
    })
    const { unmount } = render(<MediaPanel active connected />)
    const objectUrl = `blob:preview-${encodeURIComponent(IMAGE_ITEM.url)}`

    await waitFor(() =>
      expect(
        screen
          .getByTestId(`resource-thumbnail-${mediaTestIdKey(IMAGE_ITEM)}`)
          .querySelector('img')
          ?.getAttribute('src')
      ).toBe(objectUrl)
    )
    unmount()

    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl)
  })

  it('defers controlled preview loading until the thumbnail is near the viewport', async () => {
    let notifyIntersection: IntersectionObserverCallback | null = null
    const observe = vi.fn()
    const disconnect = vi.fn()
    class PreviewIntersectionObserver {
      readonly root = null
      readonly rootMargin = '160px 0px'
      readonly thresholds = [0]

      constructor(callback: IntersectionObserverCallback) {
        notifyIntersection = callback
      }

      observe = observe
      disconnect = disconnect
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return []
      }
    }
    vi.stubGlobal('IntersectionObserver', PreviewIntersectionObserver)
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [IMAGE_ITEM], selectionKinds: ['direct'] }
      }
      return {}
    })

    try {
      const { unmount } = render(<MediaPanel active connected />)
      await screen.findByText('launch-hero.webp')
      expect(observe).toHaveBeenCalledTimes(1)
      expect(loadImagePreview).not.toHaveBeenCalled()

      act(() => {
        notifyIntersection?.(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      })
      await waitFor(() => expect(loadImagePreview).toHaveBeenCalledTimes(1))

      unmount()
      expect(disconnect).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('never loads SVG media and uses the image fallback icon instead', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [SVG_ITEM], selectionKinds: ['direct'] }
      }
      return {}
    })

    render(<MediaPanel active connected />)
    const name = await screen.findByText('brand.svg')
    const row = name.closest('li')
    if (!row) throw new Error('SVG resource row missing')
    const preview = within(row).getByTestId(
      `resource-thumbnail-${mediaTestIdKey(SVG_ITEM)}`
    )

    expect(preview.getAttribute('data-preview')).toBe('fallback')
    expect(preview.querySelector('img')).toBeNull()
    expect(preview.querySelector('svg')).not.toBeNull()
    expect(loadImagePreview).not.toHaveBeenCalled()
  })

  it('keeps video and audio ahead of images in All, then ranks Images by area, size, and recency', async () => {
    const audio = {
      kind: 'direct' as const,
      url: 'https://media.example/theme.flac',
      pageUrl: 'https://media.example/watch',
      pageTitle: 'Theme',
      mimeType: 'audio/flac',
      detectedAt: 10,
    }
    const small = {
      ...IMAGE_ITEM,
      url: 'https://images.example/small.webp',
      suggestedFilename: 'small.webp',
      width: 320,
      height: 180,
      sizeBytes: 500_000,
      detectedAt: 30,
    }
    const largeOld = {
      ...IMAGE_ITEM,
      url: 'https://images.example/large-old.webp',
      suggestedFilename: 'large-old.webp',
      sizeBytes: 400_000,
      detectedAt: 20,
    }
    const largeNew = {
      ...IMAGE_ITEM,
      url: 'https://images.example/large-new.webp',
      suggestedFilename: 'large-new.webp',
      sizeBytes: 500_000,
      detectedAt: 21,
    }
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return {
          media: [small, audio, largeOld, ITEM, largeNew],
          selectionKinds: ['direct', 'mux'],
        }
      }
      return {}
    })

    render(<MediaPanel active connected />)
    const videoRow = (await screen.findByText('video.mp4')).closest('li')
    const audioRow = screen.getByText('theme.flac').closest('li')
    const smallRow = screen.getByText('small.webp').closest('li')
    if (!videoRow || !audioRow || !smallRow) throw new Error('row missing')
    expect(videoRow.compareDocumentPosition(audioRow)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(audioRow.compareDocumentPosition(smallRow)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Images' }))
    const imageRows = ['large-new.webp', 'large-old.webp', 'small.webp'].map(
      (filename) => screen.getByText(filename).closest('li')
    )
    expect(imageRows.every(Boolean)).toBe(true)
    expect(imageRows[0]?.compareDocumentPosition(imageRows[1] as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(imageRows[1]?.compareDocumentPosition(imageRows[2] as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('submits from the trailing quick action and guards against double submit', async () => {
    let resolveSubmit!: (value: { ok: true }) => void
    const submitPending = new Promise<{ ok: true }>((resolve) => {
      resolveSubmit = resolve
    })
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [ITEM], selectionKinds: ['direct', 'mux'] }
      }
      if (kind === 'bg.submitMedia') return submitPending
      return {}
    })

    render(<MediaPanel active connected />)
    const resource = await screen.findByRole('button', {
      name: 'Quick download video.mp4',
    })

    fireEvent.click(resource)
    await waitFor(() =>
      expect((resource as HTMLButtonElement).disabled).toBe(true)
    )
    fireEvent.click(resource)

    expect(submitCalls()).toHaveLength(1)
    expect(submitCalls()[0]?.[1]).toEqual({
      mediaKey: mediaStorageKey(ITEM),
      idempotencyKey: expect.any(String),
    })

    resolveSubmit({ ok: true })
    await screen.findByRole('button', { name: 'Sent video.mp4' })
    expect((resource as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps mux resources with the same video URL independently selectable and submits their distinct media keys', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return {
          media: [MUX_PRIMARY, MUX_ALTERNATE],
          selectionKinds: ['mux'],
        }
      }
      if (kind === 'bg.submitMedia') return { ok: true }
      return {}
    })

    render(<MediaPanel active connected />)
    const primarySelection = await screen.findByRole('checkbox', {
      name: 'Select primary-track.mp4',
    })
    const alternateSelection = screen.getByRole('checkbox', {
      name: 'Select alternate-track.mp4',
    })

    fireEvent.click(primarySelection)
    expect((primarySelection as HTMLInputElement).checked).toBe(true)
    expect((alternateSelection as HTMLInputElement).checked).toBe(false)
    fireEvent.click(alternateSelection)
    fireEvent.click(primarySelection)
    expect((primarySelection as HTMLInputElement).checked).toBe(false)
    expect((alternateSelection as HTMLInputElement).checked).toBe(true)

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Quick download primary-track.mp4',
      })
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Quick download alternate-track.mp4',
      })
    )

    await waitFor(() => expect(submitCalls()).toHaveLength(2))
    expect(
      submitCalls().map(
        ([, payload]) => (payload as { mediaKey: string }).mediaKey
      )
    ).toEqual([mediaStorageKey(MUX_PRIMARY), mediaStorageKey(MUX_ALTERNATE)])
  })

  it('returns a failed resource action to idle so it can retry', async () => {
    let attempts = 0
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [ITEM], selectionKinds: ['direct', 'mux'] }
      }
      if (kind === 'bg.submitMedia') {
        attempts += 1
        return attempts === 1 ? { error: 'Motrix not connected' } : { ok: true }
      }
      return {}
    })

    render(<MediaPanel active connected />)
    const resource = await screen.findByRole('button', {
      name: 'Quick download video.mp4',
    })

    fireEvent.click(resource)
    await screen.findByText(i18n.t('popup.sniffer.submitFailed'))
    expect((resource as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(resource)
    await screen.findByRole('button', { name: 'Sent video.mp4' })
    const submissions = submitCalls()
    expect(submissions).toHaveLength(2)
    const firstPayload = submissions.at(0)?.at(1)
    const retryPayload = submissions.at(1)?.at(1)
    if (!firstPayload || !retryPayload) throw new Error('missing submission')
    const firstKey = (firstPayload as { idempotencyKey: string }).idempotencyKey
    const retryKey = (retryPayload as { idempotencyKey: string }).idempotencyKey
    expect(retryKey).toBe(firstKey)
  })

  it('allows a paired offline download and keeps its receipt after reconnect', async () => {
    let scanCount = 0
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        scanCount += 1
        return {
          media: [HLS_ITEM],
          selectionKinds: scanCount === 1 ? ['direct'] : ['direct', 'hls'],
        }
      }
      if (kind === 'bg.submitMedia') return { ok: true }
      return {}
    })

    const { rerender } = render(
      <MediaPanel active connected={false} submissionKey="local" />
    )

    const selection = await screen.findByRole('checkbox', {
      name: 'Select master.m3u8',
    })
    const selectAll = screen.getByRole('checkbox', { name: 'Select all' })
    const quickDownload = within(
      screen.getByTestId(`resource-row-${mediaTestIdKey(HLS_ITEM)}`)
    ).getByRole('button')

    expect((selection as HTMLInputElement).disabled).toBe(false)
    expect((selectAll as HTMLInputElement).disabled).toBe(false)
    expect((quickDownload as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(selectAll)
    expect((selection as HTMLInputElement).checked).toBe(true)
    const batch = screen.getByRole('button', { name: 'Download selected' })
    expect((batch as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(batch)
    await screen.findByRole('button', { name: 'Sent master.m3u8' })
    expect(submitCalls()).toHaveLength(1)

    rerender(<MediaPanel active connected submissionKey="local" />)

    await waitFor(() => expect(scanCount).toBe(2))
    expect(
      screen.getByRole('button', { name: 'Sent master.m3u8' })
    ).toBeTruthy()
    expect(submitCalls()).toHaveLength(1)
  })

  it('refreshes Backend capabilities when returning to the Sniffer tab after an offline reconnect', async () => {
    let scanCount = 0
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        scanCount += 1
        return {
          media: [HLS_ITEM],
          selectionKinds: scanCount === 1 ? ['direct'] : ['direct', 'hls'],
        }
      }
      return {}
    })

    const { rerender } = render(
      <MediaPanel active connected={false} submissionKey="local" />
    )
    const selection = await screen.findByRole('checkbox', {
      name: 'Select master.m3u8',
    })
    fireEvent.click(selection)

    rerender(<MediaPanel active={false} connected submissionKey="local" />)
    expect(scanCount).toBe(1)

    rerender(<MediaPanel active connected submissionKey="local" />)

    await waitFor(() => expect(scanCount).toBe(2))
    expect((selection as HTMLInputElement).checked).toBe(true)
    expect(
      (
        screen.getByRole('button', {
          name: 'Quick download master.m3u8',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })

  it('refreshes capabilities only once after switching Backend while offline', async () => {
    let scanCount = 0
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        scanCount += 1
        return {
          media: [HLS_ITEM],
          selectionKinds: scanCount === 1 ? ['direct'] : ['direct', 'hls'],
        }
      }
      return {}
    })

    const { rerender } = render(
      <MediaPanel active connected={false} submissionKey="local" />
    )
    await screen.findByRole('checkbox', { name: 'Select master.m3u8' })

    rerender(<MediaPanel active connected submissionKey="remote" />)

    await waitFor(() => expect(scanCount).toBe(2))
    await Promise.resolve()
    expect(scanCount).toBe(2)
  })

  it('drops selections and submission feedback for resources removed by a rescan', async () => {
    let scanCount = 0
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        scanCount += 1
        return {
          media: scanCount === 1 ? [ITEM] : [HLS_ITEM],
          selectionKinds: ['direct', 'mux', 'hls'],
        }
      }
      return {}
    })

    render(<MediaPanel active connected />)
    const selection = await screen.findByRole('checkbox', {
      name: 'Select video.mp4',
    })
    fireEvent.click(selection)
    expect(screen.getByText('Download 1')).toBeTruthy()

    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('popup.sniffer.scan') })
    )

    await screen.findByRole('checkbox', { name: 'Select master.m3u8' })
    await waitFor(() => expect(screen.getByText('Download 0')).toBeTruthy())
    expect(screen.getByText('1 items')).toBeTruthy()
    expect(
      (
        screen.getByRole('button', {
          name: 'Download selected',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it('keeps selection at the row start and batch actions in the footer', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [ITEM], selectionKinds: ['direct', 'mux'] }
      }
      if (kind === 'bg.submitMedia') return { ok: true }
      return {}
    })

    render(<MediaPanel active connected />)
    const selection = await screen.findByRole('checkbox', {
      name: 'Select video.mp4',
    })
    const quickDownload = screen.getByRole('button', {
      name: 'Quick download video.mp4',
    })
    const row = selection.closest('li')

    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByRole('checkbox')).toBe(selection)
    expect(selection.compareDocumentPosition(quickDownload)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(row?.className).not.toContain('rounded-lg')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    const batch = screen.getByRole('button', { name: 'Download selected' })
    expect((batch as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(batch)

    await screen.findByRole('button', { name: 'Sent video.mp4' })
    expect(submitCalls()).toHaveLength(1)
  })

  it('limits batch submissions to four and keeps only failed resources selected with inline feedback', async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      kind: 'direct' as const,
      url: `https://media.example/resource-${index}.mp4`,
      pageUrl: 'https://media.example/watch',
      pageTitle: `Resource ${index}`,
      mimeType: 'video/mp4',
      detectedAt: index + 1,
    }))
    let activeSubmissions = 0
    let maxActiveSubmissions = 0
    const pending = new Map<
      string,
      (result: { ok: true } | { error: string }) => void
    >()
    send.mockImplementation(async (kind: string, payload?: unknown) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: items, selectionKinds: ['direct'] }
      }
      if (kind === 'bg.submitMedia') {
        const mediaKey = (payload as { mediaKey: string }).mediaKey
        activeSubmissions += 1
        maxActiveSubmissions = Math.max(maxActiveSubmissions, activeSubmissions)
        return new Promise((resolve) => {
          pending.set(mediaKey, (result) => {
            activeSubmissions -= 1
            resolve(result)
          })
        })
      }
      return {}
    })

    render(<MediaPanel active connected />)
    await screen.findByText('resource-0.mp4')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Download selected' }))

    await waitFor(() => expect(submitCalls()).toHaveLength(4))
    expect(maxActiveSubmissions).toBe(4)

    await act(async () => {
      pending.get(mediaStorageKey(items[0]))?.({ ok: true })
      pending.get(mediaStorageKey(items[1]))?.({
        error: 'backend rejected item',
      })
      pending.get(mediaStorageKey(items[2]))?.({ ok: true })
      pending.get(mediaStorageKey(items[3]))?.({ ok: true })
    })
    await waitFor(() => expect(submitCalls()).toHaveLength(6))
    expect(maxActiveSubmissions).toBe(4)

    await act(async () => {
      pending.get(mediaStorageKey(items[4]))?.({ ok: true })
      pending.get(mediaStorageKey(items[5]))?.({ ok: true })
    })

    await screen.findByText(i18n.t('popup.sniffer.submitFailed'))
    await waitFor(() => {
      expect(
        (
          screen.getByRole('checkbox', {
            name: 'Select resource-1.mp4',
          }) as HTMLInputElement
        ).checked
      ).toBe(true)
      expect(
        (
          screen.getByRole('checkbox', {
            name: 'Select resource-0.mp4',
          }) as HTMLInputElement
        ).checked
      ).toBe(false)
    })
    expect(screen.getByText('Download 1')).toBeTruthy()
  })

  it('associates the selected backend capability reason with unsupported rows', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [ITEM], selectionKinds: ['direct'] }
      }
      return {}
    })

    render(<MediaPanel active connected />)
    const resource = await screen.findByRole('button', {
      name: /video\.mp4 cannot be sent/,
    })
    const descriptionId = resource.getAttribute('aria-describedby')
    const reason = descriptionId ? document.getElementById(descriptionId) : null

    const unsupportedReason = i18n.t('popup.sniffer.unsupportedReason')
    expect(resource.getAttribute('aria-disabled')).toBe('true')
    expect(reason?.textContent).toBe(
      `${unsupportedReason} ${i18n.t('popup.sniffer.refreshCapabilitiesHint')}`
    )
    expect(reason?.className).toBe('sr-only')
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(resource.getAttribute('title')).toBeNull()
    expect(resource.getAttribute('aria-label')).toContain(unsupportedReason)

    const selection = screen.getByRole('checkbox', {
      name: 'Select video.mp4',
    })
    expect((selection as HTMLInputElement).disabled).toBe(false)
    fireEvent.click(selection)

    const batch = screen.getByRole('button', { name: 'Download selected' })
    expect((batch as HTMLButtonElement).disabled).toBe(true)
    const batchDescriptionId = batch.getAttribute('aria-describedby')
    expect(document.getElementById(batchDescriptionId ?? '')?.textContent).toBe(
      i18n.t('popup.sniffer.unsupportedSelectionReason')
    )
  })

  it.each(['hover', 'keyboard'] as const)(
    'explains disabled downloads on %s without allowing submission',
    async (interaction) => {
      const user = userEvent.setup()
      send.mockImplementation(async (kind: string) => {
        if (kind === 'bg.scanActiveTab') {
          return { media: [HLS_ITEM], selectionKinds: ['direct'] }
        }
        return {}
      })

      render(<MediaPanel active connected />)
      const resource = await screen.findByRole('button', {
        name: /master\.m3u8 cannot be sent/,
      })
      if (interaction === 'hover') {
        await user.hover(resource)
      } else {
        act(() => {
          screen.getByRole('checkbox', { name: 'Select master.m3u8' }).focus()
        })
        await user.tab()
        expect(document.activeElement).toBe(resource)
      }

      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip.textContent).toContain(
        i18n.t('popup.sniffer.unsupportedReason')
      )
      expect(tooltip.textContent).toContain(
        i18n.t('popup.sniffer.refreshCapabilitiesHint')
      )

      if (interaction === 'hover') {
        await user.click(resource)
      } else {
        await user.keyboard('{Enter} ')
      }
      expect(submitCalls()).toHaveLength(0)
      expect(resource.getAttribute('aria-disabled')).toBe('true')

      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    }
  )

  it('clears the disabled tooltip and enables downloads after a capability rescan', async () => {
    const user = userEvent.setup()
    let supported = false
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return {
          media: [HLS_ITEM],
          selectionKinds: supported ? ['direct', 'hls'] : ['direct'],
        }
      }
      return { ok: true }
    })

    render(<MediaPanel active connected />)
    await user.hover(
      await screen.findByRole('button', { name: /master\.m3u8 cannot be sent/ })
    )
    await screen.findByRole('tooltip')

    supported = true
    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('popup.sniffer.scan') })
    )
    const resource = await screen.findByRole('button', {
      name: 'Quick download master.m3u8',
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(resource.getAttribute('aria-disabled')).not.toBe('true')
    await user.click(resource)
    expect(submitCalls()).toHaveLength(1)
  })

  it('shows the complete page submission error and lets the user retry', async () => {
    tabsQuery.mockResolvedValue([
      { id: 1, url: 'https://www.youtube.com/watch?v=motrix' },
    ])
    let rejected = true
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab')
        return { media: [], selectionKinds: ['direct'] }
      if (kind === 'bg.resolvePageDownload')
        return rejected
          ? { error: 'download.unsupported' }
          : { taskId: 'retried-task' }
      return {}
    })
    render(<MediaPanel active connected />)
    const action = await screen.findByRole('button', {
      name: i18n.t('popup.sniffer.pageAction.youtube'),
    })
    fireEvent.click(action)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBeTruthy()
    expect(alert.className).not.toContain('truncate')
    expect(alert.parentElement?.className).not.toContain('h-11')
    rejected = false
    fireEvent.click(action)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('allows page resolution while paired and offline', async () => {
    tabsQuery.mockResolvedValue([
      { url: 'https://www.youtube.com/watch?v=motrix' },
    ])
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [], selectionKinds: ['direct'] }
      }
      return {}
    })

    const { rerender } = render(<MediaPanel active connected={false} />)

    const resolve = await screen.findByRole('button', {
      name: i18n.t('popup.sniffer.pageAction.youtube'),
    })
    expect((resolve as HTMLButtonElement).disabled).toBe(false)

    rerender(<MediaPanel active connected />)
    await waitFor(() => {
      const reconnected = screen.getByRole('button', {
        name: i18n.t('popup.sniffer.pageAction.youtube'),
      })
      expect((reconnected as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('shows a localized unavailable state without exposing scan errors', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { error: 'Cannot access a chrome:// URL' }
      }
      return {}
    })

    render(<MediaPanel active connected />)

    expect(
      await screen.findByText(i18n.t('popup.sniffer.unavailableTitle'))
    ).toBeTruthy()
    expect(
      screen.getByText(i18n.t('popup.sniffer.unavailableDescription'))
    ).toBeTruthy()
    expect(screen.queryByText('Cannot access a chrome:// URL')).toBeNull()
    expect(screen.queryByText(i18n.t('popup.sniffer.emptyTitle'))).toBeNull()
    expect(
      screen.queryByRole('button', { name: i18n.t('popup.sniffer.scan') })
    ).toBeNull()
  })

  it('shows exactly one scan action in the empty state', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.scanActiveTab') {
        return { media: [], selectionKinds: ['direct'] }
      }
      return {}
    })

    render(<MediaPanel active connected />)

    const scanActions = await screen.findAllByRole('button', {
      name: i18n.t('popup.sniffer.scan'),
    })

    expect(scanActions).toHaveLength(1)
    expect(
      screen.queryByText(i18n.t('popup.sniffer.emptyDescription'))
    ).toBeNull()

    fireEvent.click(scanActions[0] as HTMLElement)
    await waitFor(() =>
      expect(
        send.mock.calls.filter(([kind]) => kind === 'bg.scanActiveTab')
      ).toHaveLength(2)
    )
  })
})
