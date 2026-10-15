import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RenderedImageThumbnailSampler } from '@/content/imageThumbnail'

const WEBP_DATA_URL = 'data:image/webp;base64,V0VCUA=='

interface FixtureOptions {
  imageUrl?: string
  currentSrc?: string
  width?: number
  height?: number
  complete?: boolean
  dataUrl?: string
  encodeError?: unknown
}

function fixture(options: FixtureOptions = {}) {
  const image = {
    isConnected: true,
    complete: options.complete ?? true,
    currentSrc: options.currentSrc ?? options.imageUrl ?? '',
    src: options.imageUrl ?? 'https://cdn.example/images/photo.jpg',
    naturalWidth: options.width ?? 1_200,
    naturalHeight: options.height ?? 800,
  } as unknown as HTMLImageElement
  const drawImage = vi.fn()
  const toDataURL = vi.fn(() => {
    if (options.encodeError) throw options.encodeError
    return options.dataUrl ?? WEBP_DATA_URL
  })
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    toDataURL,
  } as unknown as HTMLCanvasElement
  const createElement = vi.fn(() => canvas)
  const images = {
    length: 1,
    item: vi.fn(() => image),
  } as unknown as HTMLCollectionOf<HTMLImageElement>
  const doc = {
    baseURI: 'https://page.example/gallery/',
    createElement,
    images,
  } as unknown as Document

  return { canvas, createElement, doc, drawImage, image, images, toDataURL }
}

describe('RenderedImageThumbnailSampler', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('center-crops an exact normalized rendered image into a 72px WebP', () => {
    const test = fixture({
      imageUrl: 'https://cdn.example/images/photo.jpg',
      width: 1_200,
      height: 800,
    })
    const sampler = new RenderedImageThumbnailSampler(test.doc)

    expect(
      sampler.capture({
        url: 'https://cdn.example/images/../images/photo.jpg',
      })
    ).toEqual({ dataUrl: WEBP_DATA_URL })
    expect(test.createElement).toHaveBeenCalledOnce()
    expect(test.createElement).toHaveBeenCalledWith('canvas')
    expect(test.drawImage).toHaveBeenCalledWith(
      test.image,
      200,
      0,
      800,
      800,
      0,
      0,
      72,
      72
    )
    expect(test.toDataURL).toHaveBeenCalledWith('image/webp', 0.78)
  })

  it('matches currentSrc and clamps requested edges to 48..96', () => {
    const test = fixture({
      currentSrc: 'https://cdn.example/responsive/photo-2x.webp',
      imageUrl: 'https://cdn.example/responsive/photo.webp',
    })
    const sampler = new RenderedImageThumbnailSampler(test.doc)

    expect(
      sampler.capture({
        url: 'https://cdn.example/responsive/photo-2x.webp',
        maxEdge: -500,
      })
    ).toEqual({ dataUrl: WEBP_DATA_URL })
    expect(
      sampler.capture({
        url: 'https://cdn.example/responsive/photo-2x.webp',
        maxEdge: 500,
      })
    ).toEqual({ dataUrl: WEBP_DATA_URL })

    expect(test.drawImage.mock.calls[0]?.slice(-2)).toEqual([48, 48])
    expect(test.drawImage.mock.calls[1]?.slice(-2)).toEqual([96, 96])
  })

  it('matches a rendered raster image after dropping a non-semantic URL fragment', () => {
    const test = fixture({
      currentSrc: 'https://cdn.example/responsive/photo.webp#display',
      imageUrl: 'https://cdn.example/responsive/photo.webp#source',
    })
    const sampler = new RenderedImageThumbnailSampler(test.doc)

    expect(
      sampler.capture({ url: 'https://cdn.example/responsive/photo.webp' })
    ).toEqual({ dataUrl: WEBP_DATA_URL })
  })

  it('accepts PNG when the browser falls back from WebP encoding', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const test = fixture({ dataUrl: png })
    const sampler = new RenderedImageThumbnailSampler(test.doc)

    expect(
      sampler.capture({ url: 'https://cdn.example/images/photo.jpg' })
    ).toEqual({ dataUrl: png })
  })

  it('rejects oversized or unexpected canvas output', () => {
    const oversized = fixture({
      dataUrl: `data:image/webp;base64,${'A'.repeat(48 * 1024)}`,
    })
    const unexpected = fixture({ dataUrl: 'data:text/html;base64,PGgxPg==' })

    expect(
      new RenderedImageThumbnailSampler(oversized.doc).capture({
        url: 'https://cdn.example/images/photo.jpg',
      })
    ).toEqual({ dataUrl: null })
    expect(
      new RenderedImageThumbnailSampler(unexpected.doc).capture({
        url: 'https://cdn.example/images/photo.jpg',
      })
    ).toEqual({ dataUrl: null })
  })

  it('does not draw unloaded, disconnected, dimensionless, or non-matching images', () => {
    for (const options of [
      { complete: false },
      { width: 0 },
      { height: 0 },
      { imageUrl: 'https://cdn.example/images/different.jpg' },
    ]) {
      const test = fixture(options)
      const sampler = new RenderedImageThumbnailSampler(test.doc)
      expect(
        sampler.capture({ url: 'https://cdn.example/images/photo.jpg' })
      ).toEqual({ dataUrl: null })
      expect(test.createElement).not.toHaveBeenCalled()
    }

    const disconnected = fixture()
    Object.defineProperty(disconnected.image, 'isConnected', { value: false })
    expect(
      new RenderedImageThumbnailSampler(disconnected.doc).capture({
        url: 'https://cdn.example/images/photo.jpg',
      })
    ).toEqual({ dataUrl: null })
  })

  it('silently rejects a canvas tainted by a cross-origin image', () => {
    const test = fixture({
      encodeError: new DOMException('Tainted', 'SecurityError'),
    })
    const sampler = new RenderedImageThumbnailSampler(test.doc)

    expect(() =>
      sampler.capture({ url: 'https://cdn.example/images/photo.jpg' })
    ).not.toThrow()
    expect(
      sampler.capture({ url: 'https://cdn.example/images/photo.jpg' })
    ).toEqual({ dataUrl: null })
  })

  it('contains hostile request, document, collection, and image getters', () => {
    const hostileRequest = Object.defineProperty({}, 'url', {
      get: () => {
        throw new Error('hostile request')
      },
    })
    const hostileDocument = {
      baseURI: 'https://page.example/',
      createElement: vi.fn(),
      get images() {
        throw new Error('hostile collection')
      },
    } as unknown as Document
    const imageTest = fixture()
    Object.defineProperty(imageTest.image, 'complete', {
      get: () => {
        throw new Error('hostile image')
      },
    })

    expect(
      new RenderedImageThumbnailSampler(hostileDocument).capture({
        url: 'https://cdn.example/images/photo.jpg',
      })
    ).toEqual({ dataUrl: null })
    expect(
      new RenderedImageThumbnailSampler(imageTest.doc).capture(hostileRequest)
    ).toEqual({ dataUrl: null })
    expect(
      new RenderedImageThumbnailSampler(imageTest.doc).capture({
        url: 'https://cdn.example/images/photo.jpg',
      })
    ).toEqual({ dataUrl: null })
  })

  it('rejects overlong and non-web URLs before touching document.images', () => {
    let imageReads = 0
    const doc = {
      baseURI: 'https://page.example/',
      createElement: vi.fn(),
      get images() {
        imageReads += 1
        return { length: 0, item: () => null }
      },
    } as unknown as Document
    const sampler = new RenderedImageThumbnailSampler(doc)

    expect(
      sampler.capture({ url: `https://x.test/${'a'.repeat(32_768)}` })
    ).toEqual({ dataUrl: null })
    expect(sampler.capture({ url: 'javascript:alert(1)' })).toEqual({
      dataUrl: null,
    })
    expect(imageReads).toBe(0)
  })

  it('caches duplicate successes and short-lived misses without new page work', () => {
    let now = 1_000
    const test = fixture()
    const sampler = new RenderedImageThumbnailSampler(test.doc, () => now)
    const request = { url: 'https://cdn.example/images/photo.jpg' }

    expect(sampler.capture(request)).toEqual({ dataUrl: WEBP_DATA_URL })
    expect(sampler.capture(request)).toEqual({ dataUrl: WEBP_DATA_URL })
    expect(test.createElement).toHaveBeenCalledOnce()

    now += 15_001
    expect(sampler.capture(request)).toEqual({ dataUrl: WEBP_DATA_URL })
    expect(test.createElement).toHaveBeenCalledTimes(2)

    const miss = fixture({ imageUrl: 'https://cdn.example/other.jpg' })
    const missSampler = new RenderedImageThumbnailSampler(miss.doc, () => now)
    expect(missSampler.capture(request)).toEqual({ dataUrl: null })
    expect(missSampler.capture(request)).toEqual({ dataUrl: null })
    expect(miss.images.item).toHaveBeenCalledOnce()
  })

  it('bounds scans even if a hostile page exposes an enormous collection', () => {
    const item = vi.fn(() => null)
    const doc = {
      baseURI: 'https://page.example/',
      createElement: vi.fn(),
      images: { length: Number.MAX_SAFE_INTEGER, item },
    } as unknown as Document

    expect(
      new RenderedImageThumbnailSampler(doc).capture({
        url: 'https://cdn.example/images/photo.jpg',
      })
    ).toEqual({ dataUrl: null })
    expect(item).toHaveBeenCalledTimes(4_096)
  })
})
