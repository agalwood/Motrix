import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadImagePreview,
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_IMAGE_PREVIEW_CHUNK_BYTES,
} from '@/popup/imagePreview'

const PNG_BYTES = pngHeader(1, 1)

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  bytes.set([73, 72, 68, 82], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function gifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10)
  bytes.set([71, 73, 70, 56, 57, 97])
  const view = new DataView(bytes.buffer)
  view.setUint16(6, width, true)
  view.setUint16(8, height, true)
  return bytes
}

function jpegHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(21)
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8])
  const view = new DataView(bytes.buffer)
  view.setUint16(7, height)
  view.setUint16(9, width)
  return bytes
}

function webpHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set([82, 73, 70, 70], 0)
  bytes.set([87, 69, 66, 80], 8)
  bytes.set([86, 80, 56, 88], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 22, true)
  view.setUint32(16, 10, true)
  const encodedWidth = width - 1
  const encodedHeight = height - 1
  bytes.set(
    [
      encodedWidth & 0xff,
      (encodedWidth >> 8) & 0xff,
      (encodedWidth >> 16) & 0xff,
    ],
    24
  )
  bytes.set(
    [
      encodedHeight & 0xff,
      (encodedHeight >> 8) & 0xff,
      (encodedHeight >> 16) & 0xff,
    ],
    27
  )
  return bytes
}

function bmpHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(54)
  bytes.set([0x42, 0x4d])
  const view = new DataView(bytes.buffer)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  return bytes
}

function tiffHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(34)
  bytes.set([0x49, 0x49, 42, 0])
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 8, true)
  view.setUint16(8, 2, true)
  view.setUint16(10, 256, true)
  view.setUint16(12, 4, true)
  view.setUint32(14, 1, true)
  view.setUint32(18, width, true)
  view.setUint16(22, 257, true)
  view.setUint16(24, 4, true)
  view.setUint32(26, 1, true)
  view.setUint32(30, height, true)
  return bytes
}

function icoHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(62)
  bytes.set([0, 0, 1, 0, 1, 0])
  bytes[6] = Math.min(width, 255)
  bytes[7] = Math.min(height, 255)
  const view = new DataView(bytes.buffer)
  view.setUint32(14, 40, true)
  view.setUint32(18, 22, true)
  view.setUint32(22, 40, true)
  view.setInt32(26, width, true)
  view.setInt32(30, height * 2, true)
  return bytes
}

function avifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 20)
  bytes.set([102, 116, 121, 112, 97, 118, 105, 102], 4)
  bytes.set([97, 118, 105, 102], 16)
  view.setUint32(20, 20)
  bytes.set([105, 115, 112, 101], 24)
  view.setUint32(32, width)
  view.setUint32(36, height)
  return bytes
}

function rasterResponse(
  body: BodyInit = PNG_BYTES,
  headers: Record<string, string> = {}
): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'image/png', ...headers },
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('loadImagePreview', () => {
  const fetchMock = vi.fn<typeof fetch>()
  let createObjectURL: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    createObjectURL = vi.spyOn(URL, 'createObjectURL')
    createObjectURL.mockReturnValue('blob:controlled-preview')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('loads a response without ACAO through an anonymous no-referrer fetch and creates a raster blob URL', async () => {
    fetchMock.mockResolvedValue(rasterResponse())

    await expect(
      loadImagePreview('https://cdn.example/no-acao.png')
    ).resolves.toBe('blob:controlled-preview')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.example/no-acao.png',
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      })
    )
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob | undefined
    expect(blob?.type).toBe('image/png')
    expect(blob?.size).toBe(PNG_BYTES.byteLength)
  })

  it('decodes, center-crops, and emits a compact 72px WebP thumbnail', async () => {
    const close = vi.fn()
    const bitmap = { width: 400, height: 200, close } as unknown as ImageBitmap
    const createImageBitmapMock = vi.fn().mockResolvedValue(bitmap)
    const drawImage = vi.fn()
    const convertToBlob = vi
      .fn()
      .mockResolvedValue(
        new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/webp' })
      )
    class FakeOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number
      ) {}

      getContext(): { drawImage: typeof drawImage } {
        return { drawImage }
      }

      convertToBlob(options: ImageEncodeOptions): Promise<Blob> {
        return convertToBlob(options)
      }
    }
    vi.stubGlobal('createImageBitmap', createImageBitmapMock)
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    fetchMock.mockResolvedValue(rasterResponse(pngHeader(400, 200)))

    await expect(
      loadImagePreview('https://cdn.example/wide.png')
    ).resolves.toBe('blob:controlled-preview')

    expect(createImageBitmapMock).toHaveBeenCalledOnce()
    expect(drawImage).toHaveBeenCalledWith(
      bitmap,
      100,
      0,
      200,
      200,
      0,
      0,
      72,
      72
    )
    expect(convertToBlob).toHaveBeenCalledWith({
      type: 'image/webp',
      quality: 0.78,
    })
    const thumbnail = createObjectURL.mock.calls[0]?.[0] as Blob | undefined
    expect(thumbnail?.type).toBe('image/webp')
    expect(thumbnail?.size).toBe(3)
    expect(close).toHaveBeenCalledOnce()
  })

  it('falls back to PNG when WebP canvas encoding is unavailable', async () => {
    const close = vi.fn()
    const bitmap = { width: 32, height: 32, close } as unknown as ImageBitmap
    const drawImage = vi.fn()
    const convertToBlob = vi
      .fn()
      .mockRejectedValueOnce(new Error('WebP unsupported'))
      .mockResolvedValueOnce(
        new Blob([Uint8Array.of(1)], { type: 'image/png' })
      )
    class FakeOffscreenCanvas {
      getContext(): { drawImage: typeof drawImage } {
        return { drawImage }
      }

      convertToBlob(options: ImageEncodeOptions): Promise<Blob> {
        return convertToBlob(options)
      }
    }
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    fetchMock.mockResolvedValue(rasterResponse(pngHeader(32, 32)))

    await expect(
      loadImagePreview('https://cdn.example/no-webp.png')
    ).resolves.toBe('blob:controlled-preview')

    expect(convertToBlob).toHaveBeenNthCalledWith(1, {
      type: 'image/webp',
      quality: 0.78,
    })
    expect(convertToBlob).toHaveBeenNthCalledWith(2, { type: 'image/png' })
    const thumbnail = createObjectURL.mock.calls[0]?.[0] as Blob | undefined
    expect(thumbnail?.type).toBe('image/png')
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([
    ['oversized edge', 8193, 1],
    ['oversized pixel count', 6000, 5000],
  ])(
    'rejects a raster header with %s before decoding',
    async (_case, width, height) => {
      const createImageBitmapMock = vi.fn()
      vi.stubGlobal('createImageBitmap', createImageBitmapMock)
      fetchMock.mockResolvedValue(rasterResponse(pngHeader(width, height)))

      await expect(
        loadImagePreview(`https://cdn.example/${width}x${height}.png`)
      ).rejects.toThrow(/dimensions exceed/)
      expect(createImageBitmapMock).not.toHaveBeenCalled()
      expect(createObjectURL).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['image/gif', gifHeader(80, 60)],
    ['image/jpeg', jpegHeader(80, 60)],
    ['image/webp', webpHeader(80, 60)],
    ['image/bmp', bmpHeader(80, 60)],
    ['image/vnd.microsoft.icon', icoHeader(80, 60)],
    ['image/tiff', tiffHeader(80, 60)],
    ['image/avif', avifHeader(80, 60)],
  ])(
    'validates common %s raster dimensions before fallback',
    async (mimeType, bytes) => {
      fetchMock.mockResolvedValue(
        rasterResponse(bytes, { 'content-type': mimeType })
      )

      await expect(
        loadImagePreview(
          `https://cdn.example/validated.${mimeType.split('/')[1]}`
        )
      ).resolves.toBe('blob:controlled-preview')
      const original = createObjectURL.mock.calls[0]?.[0] as Blob | undefined
      expect(original?.type).toBe(mimeType)
    }
  )

  it('revalidates decoded dimensions and always closes the bitmap', async () => {
    const close = vi.fn()
    const bitmap = {
      width: 9000,
      height: 1,
      close,
    } as unknown as ImageBitmap
    class FakeOffscreenCanvas {}
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    fetchMock.mockResolvedValue(rasterResponse(pngHeader(100, 100)))

    await expect(
      loadImagePreview('https://cdn.example/header-mismatch.png')
    ).rejects.toThrow(/dimensions exceed/)
    expect(close).toHaveBeenCalledOnce()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('falls back to the bounded original blob when bitmap decoding is unsupported', async () => {
    const createImageBitmapMock = vi
      .fn()
      .mockRejectedValue(new DOMException('unsupported', 'NotSupportedError'))
    class FakeOffscreenCanvas {}
    vi.stubGlobal('createImageBitmap', createImageBitmapMock)
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    fetchMock.mockResolvedValue(rasterResponse(pngHeader(120, 80)))

    await expect(
      loadImagePreview('https://cdn.example/unsupported.png')
    ).resolves.toBe('blob:controlled-preview')

    expect(createImageBitmapMock).toHaveBeenCalledOnce()
    const original = createObjectURL.mock.calls[0]?.[0] as Blob | undefined
    expect(original?.type).toBe('image/png')
    expect(original?.size).toBe(24)
  })

  it('rejects an unrecognized raster body instead of exposing it for decoding', async () => {
    fetchMock.mockResolvedValue(
      rasterResponse(Uint8Array.of(137, 80, 78, 71, 1, 2, 3, 4))
    )

    await expect(
      loadImagePreview('https://cdn.example/unverifiable.png')
    ).rejects.toThrow(/could not be verified/)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it.each([
    'http://localhost/image.png',
    'http://assets.localhost/image.png',
    'http://printer/image.png',
    'http://device.local/image.png',
    'http://127.0.0.1/image.png',
    'http://10.0.0.8/image.png',
    'http://172.16.0.8/image.png',
    'http://192.168.1.8/image.png',
    'http://169.254.1.8/image.png',
    'http://[::1]/image.png',
    'http://[fd00::8]/image.png',
    'http://[fe80::8]/image.png',
  ])('rejects non-public preview host %s before fetch', async (url) => {
    await expect(loadImagePreview(url)).rejects.toThrow(/public/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts a public domain while rejecting URL credentials', async () => {
    fetchMock.mockResolvedValueOnce(rasterResponse())
    await expect(
      loadImagePreview('https://assets.example.com/image.png')
    ).resolves.toBe('blob:controlled-preview')
    await expect(
      loadImagePreview('https://user:secret@assets.example.com/image.png')
    ).rejects.toThrow(/credentials/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the anonymous network fallback HTTPS-only', async () => {
    await expect(
      loadImagePreview('http://assets.example.com/image.png')
    ).rejects.toThrow(/HTTPS/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects declared, streamed, and single-chunk size overflows', async () => {
    fetchMock.mockResolvedValueOnce(
      rasterResponse(PNG_BYTES, {
        'content-length': String(MAX_IMAGE_PREVIEW_BYTES + 1),
      })
    )
    await expect(
      loadImagePreview('https://cdn.example/declared-too-large.png')
    ).rejects.toThrow(/size limit/)

    const streamedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 9; index += 1) {
          controller.enqueue(new Uint8Array(MAX_IMAGE_PREVIEW_CHUNK_BYTES))
        }
        controller.close()
      },
    })
    fetchMock.mockResolvedValueOnce(rasterResponse(streamedBody))
    await expect(
      loadImagePreview('https://cdn.example/streamed-too-large.png')
    ).rejects.toThrow(/size limit/)

    fetchMock.mockResolvedValueOnce(
      rasterResponse(new Uint8Array(MAX_IMAGE_PREVIEW_CHUNK_BYTES + 1))
    )
    await expect(
      loadImagePreview('https://cdn.example/chunk-too-large.png')
    ).rejects.toThrow(/chunk exceeds/)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('rejects SVG by MIME and also rejects SVG bytes disguised as a raster MIME', async () => {
    await expect(
      loadImagePreview('https://cdn.example/vector.svg')
    ).rejects.toThrow(/SVG image previews/)
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValueOnce(
      new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
      })
    )
    await expect(
      loadImagePreview('https://cdn.example/vector?id=1')
    ).rejects.toThrow(/raster image/)

    fetchMock.mockResolvedValueOnce(
      rasterResponse(
        '\uFEFF <?xml version="1.0"?> <!-- disguised --> <svg viewBox="0 0 1 1"/>'
      )
    )
    await expect(
      loadImagePreview('https://cdn.example/disguised.png')
    ).rejects.toThrow(/SVG image previews/)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('passes through AbortSignal and rejects an in-flight request when aborted', async () => {
    fetchMock.mockImplementation((_url, init) => {
      const signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true }
        )
      })
    })
    const controller = new AbortController()
    const preview = loadImagePreview('https://cdn.example/slow.png', {
      signal: controller.signal,
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
    controller.abort()

    await expect(preview).rejects.toMatchObject({ name: 'AbortError' })
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('limits global preview work to three concurrent requests', async () => {
    const requests: Array<ReturnType<typeof deferred<Response>>> = []
    fetchMock.mockImplementation(() => {
      const request = deferred<Response>()
      requests.push(request)
      return request.promise
    })
    let objectUrlIndex = 0
    createObjectURL.mockImplementation(() => {
      objectUrlIndex += 1
      return `blob:preview-${objectUrlIndex}`
    })

    const previews = Array.from({ length: 5 }, (_, index) =>
      loadImagePreview(`https://cdn.example/preview-${index}.png`)
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    requests[0]?.resolve(rasterResponse())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    requests[1]?.resolve(rasterResponse())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5))
    for (const request of requests.slice(2)) {
      request.resolve(rasterResponse())
    }

    await expect(Promise.all(previews)).resolves.toHaveLength(5)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })
})
