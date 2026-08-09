import { describe, expect, it } from 'vitest'
import { parseHlsMaster, parseHlsMedia } from './hls-parser'
import { MediaParseError, seqNumberIv } from './segment-plan'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_MASTER = 'https://h.example/master.m3u8'
const BASE_MEDIA = 'https://h.example/hi/index.m3u8'

const MASTER_NO_AUDIO = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
hi/index.m3u8
`

const MASTER_WITH_AUDIO = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="en",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aac"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,AUDIO="aac"
hi/index.m3u8
`

// Simple VOD with 2 TS segments
const MEDIA_VOD_TS = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:10
#EXTINF:9.009,
seg10.ts
#EXTINF:9.009,
seg11.ts
#EXT-X-ENDLIST
`

// VOD with fMP4 via EXT-X-MAP
const MEDIA_VOD_FMP4 = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
seg0.m4s
#EXTINF:6.0,
seg1.m4s
#EXT-X-ENDLIST
`

// AES-128 with explicit IV
const MEDIA_AES_EXPLICIT_IV = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key.bin",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:6.0,
seg0.ts
#EXTINF:6.0,
seg1.ts
#EXT-X-ENDLIST
`

// AES-128 without explicit IV — should use seqNumberIv(seq)
const MEDIA_AES_SEQ_IV = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:3
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:6.0,
seg3.ts
#EXTINF:6.0,
seg4.ts
#EXT-X-ENDLIST
`

// METHOD=NONE clears key for later segments
const MEDIA_KEY_THEN_NONE = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001
#EXTINF:6.0,
enc0.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:6.0,
plain1.ts
#EXT-X-ENDLIST
`

// SAMPLE-AES → throw unsupported-encryption
const MEDIA_SAMPLE_AES = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin",IV=0x00000000000000000000000000000000
#EXTINF:6.0,
seg0.ts
#EXT-X-ENDLIST
`

// Live (no ENDLIST, no PLAYLIST-TYPE:VOD) → throw unsupported-live
const MEDIA_LIVE = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.0,
seg0.ts
`

// EXT-X-BYTERANGE: n[@o]; running offset per resource
const MEDIA_BYTERANGE = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-BYTERANGE:1000@0
#EXTINF:6.0,
file.ts
#EXT-X-BYTERANGE:500
#EXTINF:6.0,
file.ts
#EXT-X-BYTERANGE:300
#EXTINF:6.0,
file.ts
#EXT-X-ENDLIST
`

// PLAYLIST-TYPE:VOD but no ENDLIST still treated as complete (VOD type implies complete)
const MEDIA_VOD_TYPE_NO_ENDLIST = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.0,
seg0.ts
`

// ---------------------------------------------------------------------------
// parseHlsMaster
// ---------------------------------------------------------------------------

describe('parseHlsMaster', () => {
  it('picks highest-BANDWIDTH variant', () => {
    const r = parseHlsMaster(MASTER_NO_AUDIO, BASE_MASTER)
    expect(r.variantUrl).toBe('https://h.example/hi/index.m3u8')
    expect(r.audioUrl).toBeUndefined()
  })

  it('returns resolved audioUrl when AUDIO group is present', () => {
    const r = parseHlsMaster(MASTER_WITH_AUDIO, BASE_MASTER)
    expect(r.variantUrl).toBe('https://h.example/hi/index.m3u8')
    expect(r.audioUrl).toBe('https://h.example/audio/en.m3u8')
  })

  it('resolves variant URLs relative to master playlist URL', () => {
    const r = parseHlsMaster(
      MASTER_NO_AUDIO,
      'https://cdn.example/streams/master.m3u8'
    )
    expect(r.variantUrl).toBe('https://cdn.example/streams/hi/index.m3u8')
  })

  it('throws unsupported-master when no variants found', () => {
    expect(() => parseHlsMaster('#EXTM3U\n', BASE_MASTER)).toThrowError(
      expect.objectContaining({ code: 'unsupported-master' })
    )
  })
})

// ---------------------------------------------------------------------------
// parseHlsMedia — basic VOD
// ---------------------------------------------------------------------------

describe('parseHlsMedia — TS playlist', () => {
  it('returns isComplete:true for VOD playlist with ENDLIST', () => {
    const plan = parseHlsMedia(MEDIA_VOD_TS, BASE_MEDIA)
    expect(plan.isComplete).toBe(true)
  })

  it('returns container:mpegts when no EXT-X-MAP', () => {
    const plan = parseHlsMedia(MEDIA_VOD_TS, BASE_MEDIA)
    expect(plan.container).toBe('mpegts')
  })

  it('returns ordered segments with resolved URLs', () => {
    const plan = parseHlsMedia(MEDIA_VOD_TS, BASE_MEDIA)
    expect(plan.segments).toHaveLength(2)
    expect(plan.segments[0]?.url).toBe('https://h.example/hi/seg10.ts')
    expect(plan.segments[1]?.url).toBe('https://h.example/hi/seg11.ts')
  })

  it('assigns sequential index starting at 0', () => {
    const plan = parseHlsMedia(MEDIA_VOD_TS, BASE_MEDIA)
    expect(plan.segments[0]?.index).toBe(0)
    expect(plan.segments[1]?.index).toBe(1)
  })

  it('has no init for a TS playlist', () => {
    const plan = parseHlsMedia(MEDIA_VOD_TS, BASE_MEDIA)
    expect(plan.init).toBeUndefined()
  })

  it('has no key when unencrypted', () => {
    const plan = parseHlsMedia(MEDIA_VOD_TS, BASE_MEDIA)
    expect(plan.segments[0]?.key).toBeUndefined()
    expect(plan.segments[1]?.key).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseHlsMedia — fMP4 via EXT-X-MAP
// ---------------------------------------------------------------------------

describe('parseHlsMedia — fMP4 playlist', () => {
  it('sets container:fmp4 when EXT-X-MAP is present', () => {
    const plan = parseHlsMedia(MEDIA_VOD_FMP4, BASE_MEDIA)
    expect(plan.container).toBe('fmp4')
  })

  it('produces an init segment with resolved URL', () => {
    const plan = parseHlsMedia(MEDIA_VOD_FMP4, BASE_MEDIA)
    expect(plan.init?.url).toBe('https://h.example/hi/init.mp4')
  })

  it('returns correct segment URLs', () => {
    const plan = parseHlsMedia(MEDIA_VOD_FMP4, BASE_MEDIA)
    expect(plan.segments).toHaveLength(2)
    expect(plan.segments[0]?.url).toBe('https://h.example/hi/seg0.m4s')
    expect(plan.segments[1]?.url).toBe('https://h.example/hi/seg1.m4s')
  })
})

// ---------------------------------------------------------------------------
// parseHlsMedia — AES-128 explicit IV
// ---------------------------------------------------------------------------

describe('parseHlsMedia — AES-128 explicit IV', () => {
  const BASE = 'https://h.example/hi/index.m3u8'

  it('sets key.uri (resolved) on each segment', () => {
    const plan = parseHlsMedia(MEDIA_AES_EXPLICIT_IV, BASE)
    expect(plan.segments[0]?.key?.uri).toBe('https://keys.example/key.bin')
    expect(plan.segments[1]?.key?.uri).toBe('https://keys.example/key.bin')
  })

  it('sets key.method to AES-128', () => {
    const plan = parseHlsMedia(MEDIA_AES_EXPLICIT_IV, BASE)
    expect(plan.segments[0]?.key?.method).toBe('AES-128')
  })

  it('decodes explicit IV hex into 16-byte Uint8Array', () => {
    const plan = parseHlsMedia(MEDIA_AES_EXPLICIT_IV, BASE)
    const iv = plan.segments[0]?.key?.iv
    expect(iv).toBeInstanceOf(Uint8Array)
    expect(iv).toHaveLength(16)
    // 0x000102030405060708090a0b0c0d0e0f
    for (let i = 0; i < 16; i++) {
      expect(iv?.[i]).toBe(i)
    }
  })

  it('uses same IV for both segments when IV is explicit', () => {
    const plan = parseHlsMedia(MEDIA_AES_EXPLICIT_IV, BASE)
    const iv0 = plan.segments[0]?.key?.iv
    const iv1 = plan.segments[1]?.key?.iv
    // Same IV value (explicit) — NOT the same object, but same bytes
    expect(Array.from(iv0!)).toEqual(Array.from(iv1!))
  })
})

// ---------------------------------------------------------------------------
// parseHlsMedia — AES-128 sequence-number IV (no IV attr)
// ---------------------------------------------------------------------------

describe('parseHlsMedia — AES-128 seq-number IV', () => {
  const BASE = 'https://h.example/hi/index.m3u8'

  it('uses seqNumberIv(seq) when no IV attribute given', () => {
    const plan = parseHlsMedia(MEDIA_AES_SEQ_IV, BASE)
    // EXT-X-MEDIA-SEQUENCE:3 → first segment is seq 3, second is seq 4
    const expectedIv3 = seqNumberIv(3)
    const expectedIv4 = seqNumberIv(4)
    const iv0 = plan.segments[0]?.key?.iv
    const iv1 = plan.segments[1]?.key?.iv
    expect(iv0).toBeDefined()
    expect(iv1).toBeDefined()
    expect(Array.from(iv0 ?? new Uint8Array())).toEqual(Array.from(expectedIv3))
    expect(Array.from(iv1 ?? new Uint8Array())).toEqual(Array.from(expectedIv4))
  })

  it('seqNumberIv byte placement: seq in low 8 bytes big-endian, high 8 are zero', () => {
    // Use seq=0x010203 (within safe integer range) to verify byte ordering.
    // 0x010203 = 66051. In 8 big-endian bytes: 00 00 00 00 00 01 02 03
    const iv = seqNumberIv(0x010203)
    expect(iv).toHaveLength(16)
    // High 8 bytes (indices 0–7) must be zero
    for (let i = 0; i < 8; i++) expect(iv[i]).toBe(0)
    // Low 8 bytes (indices 8–15) big-endian: 00 00 00 00 00 01 02 03
    expect(iv[8]).toBe(0x00)
    expect(iv[9]).toBe(0x00)
    expect(iv[10]).toBe(0x00)
    expect(iv[11]).toBe(0x00)
    expect(iv[12]).toBe(0x00)
    expect(iv[13]).toBe(0x01)
    expect(iv[14]).toBe(0x02)
    expect(iv[15]).toBe(0x03)
  })

  it('resolves key URI relative to playlist URL', () => {
    const plan = parseHlsMedia(MEDIA_AES_SEQ_IV, BASE)
    expect(plan.segments[0]?.key?.uri).toBe('https://h.example/hi/key.bin')
  })
})

// ---------------------------------------------------------------------------
// parseHlsMedia — METHOD=NONE clears key
// ---------------------------------------------------------------------------

describe('parseHlsMedia — METHOD=NONE clears encryption', () => {
  const BASE = 'https://h.example/hi/index.m3u8'

  it('encrypted segment has key', () => {
    const plan = parseHlsMedia(MEDIA_KEY_THEN_NONE, BASE)
    expect(plan.segments[0]?.key).toBeDefined()
    expect(plan.segments[0]?.key?.method).toBe('AES-128')
  })

  it('segment after METHOD=NONE has no key', () => {
    const plan = parseHlsMedia(MEDIA_KEY_THEN_NONE, BASE)
    expect(plan.segments[1]?.key).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseHlsMedia — SAMPLE-AES throws unsupported-encryption
// ---------------------------------------------------------------------------

describe('parseHlsMedia — SAMPLE-AES', () => {
  it('throws MediaParseError with code unsupported-encryption', () => {
    expect(() => parseHlsMedia(MEDIA_SAMPLE_AES, BASE_MEDIA)).toThrowError(
      expect.objectContaining({ code: 'unsupported-encryption' })
    )
  })

  it('thrown error is a MediaParseError', () => {
    expect(() => parseHlsMedia(MEDIA_SAMPLE_AES, BASE_MEDIA)).toThrowError(
      MediaParseError
    )
  })
})

// ---------------------------------------------------------------------------
// parseHlsMedia — live playlist throws unsupported-live
// ---------------------------------------------------------------------------

describe('parseHlsMedia — live playlist', () => {
  it('throws MediaParseError with code unsupported-live', () => {
    expect(() => parseHlsMedia(MEDIA_LIVE, BASE_MEDIA)).toThrowError(
      expect.objectContaining({ code: 'unsupported-live' })
    )
  })
})

describe('parseHlsMedia — VOD type without ENDLIST', () => {
  it('isComplete:true when PLAYLIST-TYPE:VOD even without ENDLIST', () => {
    const plan = parseHlsMedia(MEDIA_VOD_TYPE_NO_ENDLIST, BASE_MEDIA)
    expect(plan.isComplete).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseHlsMedia — EXT-X-BYTERANGE running offset
// ---------------------------------------------------------------------------

describe('parseHlsMedia — EXT-X-BYTERANGE', () => {
  const BASE = 'https://h.example/hi/index.m3u8'

  it('first byterange with explicit @offset', () => {
    const plan = parseHlsMedia(MEDIA_BYTERANGE, BASE)
    expect(plan.segments[0]?.byteRange).toEqual({ offset: 0, length: 1000 })
  })

  it('second byterange without @offset uses running offset (0 + 1000 = 1000)', () => {
    const plan = parseHlsMedia(MEDIA_BYTERANGE, BASE)
    expect(plan.segments[1]?.byteRange).toEqual({ offset: 1000, length: 500 })
  })

  it('third byterange continues running offset (1000 + 500 = 1500)', () => {
    const plan = parseHlsMedia(MEDIA_BYTERANGE, BASE)
    expect(plan.segments[2]?.byteRange).toEqual({ offset: 1500, length: 300 })
  })

  it('all three segments point to the same resolved URL', () => {
    const plan = parseHlsMedia(MEDIA_BYTERANGE, BASE)
    const url = 'https://h.example/hi/file.ts'
    expect(plan.segments[0]?.url).toBe(url)
    expect(plan.segments[1]?.url).toBe(url)
    expect(plan.segments[2]?.url).toBe(url)
  })
})

// ---------------------------------------------------------------------------
// parseHlsMedia — EXT-X-BYTERANGE on EXT-X-MAP
// ---------------------------------------------------------------------------

const MEDIA_MAP_BYTERANGE = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="multi.mp4",BYTERANGE="1000@0"
#EXTINF:6.0,
#EXT-X-BYTERANGE:2000@1000
multi.mp4
#EXT-X-ENDLIST
`

describe('parseHlsMedia — EXT-X-MAP with BYTERANGE', () => {
  const BASE = 'https://h.example/hi/index.m3u8'

  it('init segment has byteRange from MAP BYTERANGE attr', () => {
    const plan = parseHlsMedia(MEDIA_MAP_BYTERANGE, BASE)
    expect(plan.init?.byteRange).toEqual({ offset: 0, length: 1000 })
  })

  it('segment byteRange is resolved correctly', () => {
    const plan = parseHlsMedia(MEDIA_MAP_BYTERANGE, BASE)
    expect(plan.segments[0]?.byteRange).toEqual({ offset: 1000, length: 2000 })
  })
})
