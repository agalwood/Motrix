import { describe, expect, it } from 'vitest'
import {
  inspectFetchResponseBody,
  inspectMediaBodyText,
  MEDIA_BODY_LIMITS,
  readBoundedResponseText,
} from '@/content/mediaBodySniffer'

describe('media response body discovery', () => {
  it('recognizes an extensionless HLS body and nested playlists, not segments', () => {
    const items = inspectMediaBodyText(
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
        '# a harmless comment between the tag and URI',
        'variants/720p?token=signed',
        '#EXTINF:4,',
        'segments/00001.ts',
      ].join('\n'),
      'https://media.example/api/playlist?id=1',
      'text/plain'
    )

    expect(items).toEqual([
      {
        url: 'https://media.example/api/playlist?id=1',
        contentType: 'application/vnd.apple.mpegurl',
        evidence: ['body-hls'],
      },
      {
        url: 'https://media.example/api/variants/720p?token=signed',
        contentType: 'application/vnd.apple.mpegurl',
        evidence: ['body-hls'],
      },
    ])
  })

  it('recognizes extensionless DASH and bounded JSON media URLs', () => {
    expect(
      inspectMediaBodyText(
        '<?xml version="1.0"?><MPD type="static"></MPD>',
        'https://media.example/manifest?id=2',
        'application/xml'
      )
    ).toEqual([
      {
        url: 'https://media.example/manifest?id=2',
        contentType: 'application/dash+xml',
        evidence: ['body-dash'],
      },
    ])

    const tooDeep = Array.from(
      { length: MEDIA_BODY_LIMITS.maxJsonDepth + 2 },
      () => ({ nested: null as unknown })
    )
    for (let index = 0; index < tooDeep.length - 1; index += 1) {
      const current = tooDeep[index]
      const next = tooDeep[index + 1]
      if (current) current.nested = next
    }
    const tail = tooDeep.at(-1)
    if (tail) tail.nested = 'https://cdn.example/too-deep.mp4'

    const items = inspectMediaBodyText(
      JSON.stringify({
        video: 'https://cdn.example/video.mp4',
        audio: '/audio/theme.m4a',
        duplicate: 'https://cdn.example/video.mp4',
        tooDeep: tooDeep[0],
        page: 'https://cdn.example/page.html',
      }),
      'https://media.example/api/data',
      'application/json; charset=utf-8'
    )
    expect(items).toEqual([
      {
        url: 'https://cdn.example/video.mp4',
        contentType: 'video/mp4',
        evidence: ['body-json'],
      },
      {
        url: 'https://media.example/audio/theme.m4a',
        contentType: 'audio/mp4',
        evidence: ['body-json'],
      },
    ])
  })

  it('reads only bounded response clones and leaves the page response intact', async () => {
    const original = new Response(
      JSON.stringify({ media: 'https://cdn.example/movie.mp4' }),
      { headers: { 'content-type': 'application/json' } }
    )

    await expect(
      inspectFetchResponseBody(original, 'https://api.example/media')
    ).resolves.toEqual([
      {
        url: 'https://cdn.example/movie.mp4',
        contentType: 'video/mp4',
        evidence: ['body-json'],
      },
    ])
    await expect(original.json()).resolves.toEqual({
      media: 'https://cdn.example/movie.mp4',
    })

    const oversized = new Response('not read', {
      headers: {
        'content-length': String(MEDIA_BODY_LIMITS.maxBytes + 1),
      },
    })
    await expect(readBoundedResponseText(oversized)).resolves.toBeNull()
  })

  it('cancels a response clone fragmented into too many chunks', async () => {
    let count = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        count += 1
        controller.enqueue(new Uint8Array([65]))
        if (count > MEDIA_BODY_LIMITS.maxChunks) controller.close()
      },
    })
    await expect(
      readBoundedResponseText(new Response(stream))
    ).resolves.toBeNull()
  })

  it('settles promptly when an oversized clone is cancelled while the page branch stays unread', async () => {
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MEDIA_BODY_LIMITS.maxBytes + 1))
        },
      }),
      { headers: { 'content-type': 'text/plain' } }
    )

    const outcome = await Promise.race([
      inspectFetchResponseBody(original, 'https://api.example/infinite').then(
        (items) => ({ kind: 'settled' as const, items })
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 100)
      }),
    ])

    expect(outcome).toEqual({ kind: 'settled', items: [] })
    await original.body?.cancel()
  })
})
