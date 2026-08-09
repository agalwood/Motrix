import { describe, expect, it } from 'vitest'
import { parseDash } from './dash-parser'

const BASE_URL = 'https://cdn.example/streams/m.mpd'

// ── SegmentTemplate + SegmentTimeline ($Number$ + $Time$, r-repeat, t-continuation) ──
const TIMELINE_NUMBER_MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT20S"
     xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period duration="PT20S">
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate timescale="90000" startNumber="1"
     initialization="init-$RepresentationID$.mp4"
     media="seg-$RepresentationID$-$Number%05d$.m4s">
    <SegmentTimeline>
     <S t="0" d="180000" r="1"/>
     <S d="90000" r="2"/>
    </SegmentTimeline>
   </SegmentTemplate>
   <Representation id="v" bandwidth="1000000"/>
  </AdaptationSet>
 </Period>
</MPD>`

// S t=0 d=180000 r=1 → 2 segments (r=1 means r+1=2):
//   seg1: number=1, time=0
//   seg2: number=2, time=180000
// S d=90000 r=2 → 3 segments (r=2 means r+1=3), t continues from prev:
//   seg3: number=3, time=360000
//   seg4: number=4, time=450000
//   seg5: number=5, time=540000

const TIMELINE_TIME_MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT10S"
     xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period duration="PT10S">
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate timescale="1000" startNumber="1"
     initialization="init.mp4"
     media="chunk-$Time$.m4s">
    <SegmentTimeline>
     <S t="0" d="2000" r="0"/>
     <S t="2000" d="3000" r="0"/>
     <S t="5000" d="5000" r="0"/>
    </SegmentTimeline>
   </SegmentTemplate>
   <Representation id="r1" bandwidth="500000"/>
  </AdaptationSet>
 </Period>
</MPD>`

// ── SegmentTemplate + duration (no timeline, count from period duration) ──
const DURATION_TEMPLATE_MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT9S"
     xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate timescale="1000" duration="3000" startNumber="5"
     initialization="init-$RepresentationID$.mp4"
     media="seg-$RepresentationID$-$Number$-$Bandwidth$.m4s"/>
   <Representation id="r1" bandwidth="2000000"/>
  </AdaptationSet>
 </Period>
</MPD>`
// count = ceil(9s * 1000 / 3000) = 3; numbers = 5, 6, 7; times = 0, 3000, 6000

// ── SegmentList (with mediaRange + Initialization) ──
const SEGLIST_MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT6S"
     xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <Representation id="v1" bandwidth="800000">
    <SegmentList>
     <Initialization sourceURL="init.mp4" range="0-1023"/>
     <SegmentURL media="chunk.mp4" mediaRange="1024-4095"/>
     <SegmentURL media="chunk.mp4" mediaRange="4096-8191"/>
    </SegmentList>
   </Representation>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4">
   <Representation id="a1" bandwidth="128000">
    <SegmentList>
     <Initialization sourceURL="ainit.mp4"/>
     <SegmentURL media="audio.mp4" mediaRange="0-999"/>
    </SegmentList>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`

// ── SegmentBase / plain BaseURL → single part ──
const SEGBASE_MPD = `<?xml version="1.0"?>
<MPD type="static" xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <Representation id="v" bandwidth="1000000">
    <BaseURL>video.mp4</BaseURL>
    <SegmentBase/>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`

const PLAIN_BASEURL_MPD = `<?xml version="1.0"?>
<MPD type="static" xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <Representation id="v1" bandwidth="500000" baseURL="v1.mp4"/>
   <Representation id="v2" bandwidth="1500000" baseURL="v2.mp4"/>
  </AdaptationSet>
 </Period>
</MPD>`

// ── Highest-bandwidth selection (video + audio) ──
const BANDWIDTH_SELECT_MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT4S"
     xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate timescale="1000" duration="4000" startNumber="1"
     initialization="init-v.mp4" media="seg-v-$Number$.m4s"/>
   <Representation id="low" bandwidth="400000"/>
   <Representation id="high" bandwidth="2000000"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4">
   <SegmentTemplate timescale="1000" duration="4000" startNumber="1"
     initialization="init-a.mp4" media="seg-a-$Number$.m4s"/>
   <Representation id="a128" bandwidth="128000"/>
   <Representation id="a256" bandwidth="256000"/>
  </AdaptationSet>
 </Period>
</MPD>`

// ── BaseURL hierarchy resolution ──
const BASEURL_HIERARCHY_MPD = `<?xml version="1.0"?>
<MPD type="static" xmlns="urn:mpeg:dash:schema:mpd:2011">
 <BaseURL>https://cdn2.example/content/</BaseURL>
 <Period>
  <BaseURL>show1/</BaseURL>
  <AdaptationSet mimeType="video/mp4">
   <BaseURL>video/</BaseURL>
   <Representation id="v" bandwidth="2000000">
    <BaseURL>1080p.mp4</BaseURL>
    <SegmentBase/>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`

// ── Dynamic MPD → unsupported-live ──
const DYNAMIC_MPD = `<?xml version="1.0"?>
<MPD type="dynamic" xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period><AdaptationSet mimeType="video/mp4">
  <Representation id="v" bandwidth="1000000" baseURL="v.mp4"/>
 </AdaptationSet></Period>
</MPD>`

// ── ContentProtection → unsupported-encryption ──
const DRM_MPD = `<?xml version="1.0"?>
<MPD type="static" xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period><AdaptationSet mimeType="video/mp4">
  <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
  <Representation id="v" bandwidth="1000000" baseURL="v.mp4"/>
 </AdaptationSet></Period>
</MPD>`

// ── No video representations ──
const NO_VIDEO_MPD = `<?xml version="1.0"?>
<MPD type="static" xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period>
  <AdaptationSet mimeType="audio/mp4">
   <Representation id="a1" bandwidth="128000" baseURL="a.mp4"/>
  </AdaptationSet>
 </Period>
</MPD>`

// ── SegmentTimeline with r=-1 ──
const TIMELINE_NEG_R_MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT10S"
     xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period duration="PT10S">
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate timescale="1000" startNumber="1"
     initialization="init.mp4"
     media="seg-$Number$.m4s">
    <SegmentTimeline>
     <S t="0" d="2000" r="-1"/>
    </SegmentTimeline>
   </SegmentTemplate>
   <Representation id="r1" bandwidth="500000"/>
  </AdaptationSet>
 </Period>
</MPD>`
// r=-1 → fill period: 10s * 1000 / 2000 = 5 segments: numbers 1-5, times 0,2000,4000,6000,8000

// ── Static MPD with type="dynamic" on child element (should NOT throw) ──
const STATIC_WITH_DYNAMIC_CHILD_MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT8S"
     xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period duration="PT8S">
  <AdaptationSet mimeType="video/mp4">
   <SupplementalProperty type="dynamic"/>
   <SegmentTemplate timescale="1000" duration="4000" startNumber="1"
     initialization="init.mp4" media="seg-$Number$.m4s"/>
   <Representation id="v" bandwidth="1500000"/>
  </AdaptationSet>
 </Period>
</MPD>`

describe('parseDash', () => {
  describe('SegmentTemplate + SegmentTimeline ($Number$ expansion)', () => {
    it('expands r-repeat and t-continuation with $Number%05d$ format', () => {
      const { video, audio } = parseDash(TIMELINE_NUMBER_MPD, BASE_URL)
      expect(audio).toBeUndefined()
      expect(video.container).toBe('fmp4')
      expect(video.isComplete).toBe(true)
      // init
      expect(video.init?.url).toBe('https://cdn.example/streams/init-v.mp4')
      // 5 segments: numbers 1..5 with %05d padding
      expect(video.segments).toHaveLength(5)
      expect(video.segments[0].url).toBe(
        'https://cdn.example/streams/seg-v-00001.m4s'
      )
      expect(video.segments[1].url).toBe(
        'https://cdn.example/streams/seg-v-00002.m4s'
      )
      expect(video.segments[2].url).toBe(
        'https://cdn.example/streams/seg-v-00003.m4s'
      )
      expect(video.segments[4].url).toBe(
        'https://cdn.example/streams/seg-v-00005.m4s'
      )
    })
  })

  describe('SegmentTemplate + SegmentTimeline ($Time$ expansion)', () => {
    it('uses time values in URL template', () => {
      const { video } = parseDash(TIMELINE_TIME_MPD, BASE_URL)
      expect(video.segments).toHaveLength(3)
      expect(video.segments[0].url).toBe(
        'https://cdn.example/streams/chunk-0.m4s'
      )
      expect(video.segments[1].url).toBe(
        'https://cdn.example/streams/chunk-2000.m4s'
      )
      expect(video.segments[2].url).toBe(
        'https://cdn.example/streams/chunk-5000.m4s'
      )
    })
  })

  describe('SegmentTemplate + duration (no timeline)', () => {
    it('computes count from period duration and expands $Number$ and $Bandwidth$', () => {
      const { video } = parseDash(DURATION_TEMPLATE_MPD, BASE_URL)
      expect(video.container).toBe('fmp4')
      // count = ceil(9 * 1000 / 3000) = 3
      expect(video.segments).toHaveLength(3)
      expect(video.init?.url).toBe('https://cdn.example/streams/init-r1.mp4')
      // startNumber=5, so numbers are 5, 6, 7; bandwidth=2000000
      expect(video.segments[0].url).toBe(
        'https://cdn.example/streams/seg-r1-5-2000000.m4s'
      )
      expect(video.segments[1].url).toBe(
        'https://cdn.example/streams/seg-r1-6-2000000.m4s'
      )
      expect(video.segments[2].url).toBe(
        'https://cdn.example/streams/seg-r1-7-2000000.m4s'
      )
    })
  })

  describe('SegmentList', () => {
    it('produces ordered parts with byteRange from mediaRange, and init with byteRange', () => {
      const { video, audio } = parseDash(SEGLIST_MPD, BASE_URL)
      expect(video.container).toBe('fmp4')
      expect(video.init?.url).toBe('https://cdn.example/streams/init.mp4')
      expect(video.init?.byteRange).toEqual({ offset: 0, length: 1024 })
      expect(video.segments).toHaveLength(2)
      expect(video.segments[0].url).toBe(
        'https://cdn.example/streams/chunk.mp4'
      )
      expect(video.segments[0].byteRange).toEqual({
        offset: 1024,
        length: 3072,
      })
      expect(video.segments[1].byteRange).toEqual({
        offset: 4096,
        length: 4096,
      })
      // audio
      expect(audio).toBeDefined()
      expect(audio?.init?.url).toBe('https://cdn.example/streams/ainit.mp4')
      expect(audio?.init?.byteRange).toBeUndefined()
      expect(audio?.segments[0].byteRange).toEqual({ offset: 0, length: 1000 })
    })
  })

  describe('SegmentBase / plain BaseURL', () => {
    it('SegmentBase emits container:single, no init, one part = whole file', () => {
      const { video } = parseDash(SEGBASE_MPD, BASE_URL)
      expect(video.container).toBe('single')
      expect(video.init).toBeUndefined()
      expect(video.segments).toHaveLength(1)
      expect(video.segments[0].url).toBe(
        'https://cdn.example/streams/video.mp4'
      )
    })

    it('plain baseURL attribute (no SegmentBase/Template/List) emits container:single', () => {
      const { video } = parseDash(PLAIN_BASEURL_MPD, BASE_URL)
      expect(video.container).toBe('single')
      expect(video.segments).toHaveLength(1)
      // should pick highest bandwidth: v2=1500000
      expect(video.segments[0].url).toBe('https://cdn.example/streams/v2.mp4')
    })
  })

  describe('highest-bandwidth selection', () => {
    it('picks highest-bandwidth video and highest-bandwidth audio', () => {
      const { video, audio } = parseDash(BANDWIDTH_SELECT_MPD, BASE_URL)
      // video: high=2000000 → init-v.mp4
      expect(video.init?.url).toBe('https://cdn.example/streams/init-v.mp4')
      expect(video.segments[0].url).toBe(
        'https://cdn.example/streams/seg-v-1.m4s'
      )
      // audio: a256=256000 → init-a.mp4
      expect(audio?.init?.url).toBe('https://cdn.example/streams/init-a.mp4')
      expect(audio?.segments[0].url).toBe(
        'https://cdn.example/streams/seg-a-1.m4s'
      )
    })
  })

  describe('BaseURL hierarchy resolution', () => {
    it('resolves nested BaseURL elements cumulatively against the mpd URL', () => {
      const { video } = parseDash(
        BASEURL_HIERARCHY_MPD,
        'https://origin.example/mpd/manifest.mpd'
      )
      expect(video.container).toBe('single')
      expect(video.segments[0].url).toBe(
        'https://cdn2.example/content/show1/video/1080p.mp4'
      )
    })
  })

  describe('error cases', () => {
    it('throws unsupported-live for type=dynamic', () => {
      expect(() => parseDash(DYNAMIC_MPD, BASE_URL)).toThrow(
        expect.objectContaining({ code: 'unsupported-live' })
      )
    })

    it('throws unsupported-encryption for ContentProtection', () => {
      expect(() => parseDash(DRM_MPD, BASE_URL)).toThrow(
        expect.objectContaining({ code: 'unsupported-encryption' })
      )
    })

    it('throws unsupported-master when no video representations exist', () => {
      expect(() => parseDash(NO_VIDEO_MPD, BASE_URL)).toThrow(
        expect.objectContaining({ code: 'unsupported-master' })
      )
    })

    it('does not throw for static MPD with type="dynamic" on child element (I-1 regression)', () => {
      const { video } = parseDash(STATIC_WITH_DYNAMIC_CHILD_MPD, BASE_URL)
      expect(video.container).toBe('fmp4')
      expect(video.segments).toHaveLength(2)
      expect(video.init?.url).toBe('https://cdn.example/streams/init.mp4')
      expect(video.segments[0].url).toBe(
        'https://cdn.example/streams/seg-1.m4s'
      )
      expect(video.segments[1].url).toBe(
        'https://cdn.example/streams/seg-2.m4s'
      )
    })
  })

  describe('SegmentTimeline r=-1', () => {
    it('repeats until period end when r=-1', () => {
      const { video } = parseDash(TIMELINE_NEG_R_MPD, BASE_URL)
      // 10s * 1000ts / 2000d = 5 segments
      expect(video.segments).toHaveLength(5)
      expect(video.segments[0].url).toBe(
        'https://cdn.example/streams/seg-1.m4s'
      )
      expect(video.segments[4].url).toBe(
        'https://cdn.example/streams/seg-5.m4s'
      )
    })
  })
})
