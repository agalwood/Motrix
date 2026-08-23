import { DownloadErrorCode } from '@shared/errors'
import { TaskStatus, TaskType, TransitionPhase } from '@shared/types/task'
import { describe, expect, it } from 'vitest'
import {
  bitfieldProgress,
  decodeAria2PeerId,
  derivePathsFromRaw,
  translateErrorCode,
  translatePeer,
  translateRawToTask,
  translateStatus,
} from './translate'
import type { Aria2RawPeer, Aria2RawStatus } from './types'

function makeRaw(overrides: Partial<Aria2RawStatus> = {}): Aria2RawStatus {
  return {
    gid: 'gid-test',
    status: 'active',
    totalLength: '1000',
    completedLength: '500',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    numSeeders: '0',
    seeder: 'false',
    pieceLength: '1000',
    numPieces: '1',
    dir: '/downloads',
    files: [
      {
        index: '1',
        path: '/downloads/sample.bin.motrix',
        length: '1000',
        completedLength: '500',
        selected: 'true',
        uris: [{ uri: 'http://example.com/sample.bin', status: 'used' }],
      },
    ],
    ...overrides,
  }
}

describe('derivePathsFromRaw', () => {
  it('HTTP: strips .motrix suffix for finalPath, keeps it for diskPath', () => {
    const derived = derivePathsFromRaw(makeRaw())
    expect(derived.diskPath).toBe('/downloads/sample.bin.motrix')
    expect(derived.finalPath).toBe('/downloads/sample.bin')
    expect(derived.finalName).toBe('sample.bin')
  })

  it('HTTP: leaves path unchanged when file already lacks suffix', () => {
    const derived = derivePathsFromRaw(
      makeRaw({
        files: [
          {
            index: '1',
            path: '/downloads/legacy.bin',
            length: '1000',
            completedLength: '500',
            selected: 'true',
            uris: [{ uri: 'http://example.com/legacy.bin', status: 'used' }],
          },
        ],
      })
    )
    expect(derived.diskPath).toBe('/downloads/legacy.bin')
    expect(derived.finalPath).toBe('/downloads/legacy.bin')
    expect(derived.finalName).toBe('legacy.bin')
  })

  it('BT: uses raw.dir as diskPath (container), strips suffix for finalPath', () => {
    const raw = makeRaw({
      dir: '/downloads/torrent-root.motrix',
      bittorrent: {
        announceList: [],
        mode: 'multi',
        info: { name: 'torrent-root' },
      },
      files: [
        {
          index: '1',
          path: '/downloads/torrent-root.motrix/a.bin',
          length: '1000',
          completedLength: '500',
          selected: 'true',
          uris: [],
        },
      ],
    })
    const derived = derivePathsFromRaw(raw)
    expect(derived.diskPath).toBe('/downloads/torrent-root.motrix')
    expect(derived.finalPath).toBe('/downloads/torrent-root')
    expect(derived.finalName).toBe('torrent-root')
  })

  it('falls back to empty strings when neither files nor dir available', () => {
    const derived = derivePathsFromRaw(makeRaw({ dir: '', files: [] }))
    expect(derived.diskPath).toBe('')
    expect(derived.finalPath).toBe('')
    expect(derived.finalName).toBe('')
  })
})

describe('translateRawToTask path fields', () => {
  it('populates diskPath/finalPath/finalName from aria2 raw', () => {
    const task = translateRawToTask(makeRaw())
    expect(task.type).toBe(TaskType.Http)
    expect(task.diskPath).toBe('/downloads/sample.bin.motrix')
    expect(task.finalPath).toBe('/downloads/sample.bin')
    expect(task.finalName).toBe('sample.bin')
    expect(task.pieceLength).toBe(1000)
    expect(task.transitionPhase).toBe(TransitionPhase.Idle)
    expect(task.torrentMetaPath).toBeNull()
  })

  it('BT: populates paths from raw.dir container', () => {
    const raw = makeRaw({
      dir: '/downloads/my-torrent.motrix',
      bittorrent: {
        announceList: [],
        mode: 'multi',
        info: { name: 'my-torrent' },
      },
    })
    const task = translateRawToTask(raw)
    expect(task.type).toBe(TaskType.Bt)
    expect(task.diskPath).toBe('/downloads/my-torrent.motrix')
    expect(task.finalPath).toBe('/downloads/my-torrent')
    expect(task.finalName).toBe('my-torrent')
  })

  it('BT: normalizes aria2 selected file indices to 0-based domain indices', () => {
    const task = translateRawToTask(
      makeRaw({
        bittorrent: {
          announceList: [],
          mode: 'multi',
          info: { name: 'my-torrent' },
        },
        files: [
          {
            index: '1',
            path: '/downloads/my-torrent.motrix/a.bin',
            length: '400',
            completedLength: '0',
            selected: 'true',
            uris: [],
          },
          {
            index: '3',
            path: '/downloads/my-torrent.motrix/c.bin',
            length: '600',
            completedLength: '0',
            selected: 'true',
            uris: [],
          },
        ],
      })
    )

    expect(task.bt?.selectedFiles).toEqual([0, 2])
  })

  // Adopted orphans (restore Pass 1 / poll discovery) mint their display
  // name from aria2's on-disk file name — which carries the `.motrix`
  // in-flight placeholder for HTTP tasks. The internal suffix must never
  // surface as a task name in the Downloads list.
  it('HTTP: display name/filename never carry the .motrix placeholder', () => {
    const task = translateRawToTask(makeRaw())
    expect(task.name).toBe('sample.bin')
    expect(task.filename).toBe('sample.bin')
    // The on-disk truth stays suffixed — only the display fields strip.
    expect(task.diskPath).toBe('/downloads/sample.bin.motrix')
  })
})

describe('translateStatus', () => {
  it('BT: active + totalLength=0 + bittorrent present → FetchingMetadata', () => {
    const raw = makeRaw({
      status: 'active',
      totalLength: '0',
      bittorrent: {
        announceList: [],
        mode: 'multi',
        info: { name: 'pending' },
      },
    })
    expect(translateStatus(raw)).toBe(TaskStatus.FetchingMetadata)
  })

  it('HTTP: active + totalLength=0 (no bittorrent) → Downloading', () => {
    // aria2 reports this shape briefly between connect and the
    // Content-Length response header arriving, and persistently for
    // chunked-transfer servers. It is NOT torrent metadata fetching.
    const raw = makeRaw({ status: 'active', totalLength: '0' })
    expect(raw.bittorrent).toBeUndefined()
    expect(translateStatus(raw)).toBe(TaskStatus.Downloading)
  })

  it('HTTP: active + totalLength>0 → Downloading', () => {
    expect(translateStatus(makeRaw())).toBe(TaskStatus.Downloading)
  })

  it('error → Error regardless of type', () => {
    expect(translateStatus(makeRaw({ status: 'error' }))).toBe(TaskStatus.Error)
  })
})

describe('translateErrorCode', () => {
  const expected = new Map<number, DownloadErrorCode | null>([
    [0, null],
    [1, DownloadErrorCode.Unknown],
    [2, DownloadErrorCode.Timeout],
    [3, DownloadErrorCode.NotFound],
    [4, DownloadErrorCode.NotFound],
    [5, DownloadErrorCode.Timeout],
    [6, DownloadErrorCode.NetworkError],
    [7, DownloadErrorCode.Unknown],
    [8, DownloadErrorCode.ServerError],
    [9, DownloadErrorCode.DiskFull],
    [10, DownloadErrorCode.ChecksumMismatch],
    [11, DownloadErrorCode.FileWriteError],
    [12, DownloadErrorCode.Unknown],
    [13, DownloadErrorCode.FileWriteError],
    [14, DownloadErrorCode.FileWriteError],
    [15, DownloadErrorCode.FileWriteError],
    [16, DownloadErrorCode.FileWriteError],
    [17, DownloadErrorCode.FileWriteError],
    [18, DownloadErrorCode.FileWriteError],
    [19, DownloadErrorCode.NetworkError],
    [20, DownloadErrorCode.Unknown],
    [21, DownloadErrorCode.ServerError],
    [22, DownloadErrorCode.ServerError],
    [23, DownloadErrorCode.TooManyRedirects],
    [24, DownloadErrorCode.Unauthorized],
    [25, DownloadErrorCode.BtMetadataFailed],
    [26, DownloadErrorCode.BtMetadataFailed],
    [27, DownloadErrorCode.BtMetadataFailed],
    [28, DownloadErrorCode.Unknown],
    [29, DownloadErrorCode.ServerError],
    [30, DownloadErrorCode.Unknown],
    [31, DownloadErrorCode.Unknown],
    [32, DownloadErrorCode.ChecksumMismatch],
  ])

  it.each([...expected.entries()])('maps aria2 code %i', (code, result) => {
    expect(translateErrorCode(String(code))).toBe(result)
  })

  it.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['   ', null],
    ['invalid', DownloadErrorCode.Unknown],
    ['33', DownloadErrorCode.Unknown],
    ['999', DownloadErrorCode.Unknown],
  ] as const)('maps edge value %s', (raw, result) => {
    expect(translateErrorCode(raw)).toBe(result)
  })

  it('preserves the aria2 error message separately from its domain code', () => {
    const task = translateRawToTask(
      makeRaw({
        status: 'error',
        errorCode: '3',
        errorMessage: 'server said the resource vanished',
      })
    )
    expect(task.errorCode).toBe(DownloadErrorCode.NotFound)
    expect(task.errorMessage).toBe('server said the resource vanished')
  })
})

describe('decodeAria2PeerId', () => {
  it('decodes percent-escaped bytes to a Buffer', () => {
    // "-qB4670-" + 12 ASCII chars = 20 bytes utf-8 ascii
    const encoded = '%2DqB4670%2DaBcDeFgHiJkL'
    const buf = decodeAria2PeerId(encoded)
    expect(buf.length).toBe(20)
    expect(buf.toString('utf8')).toBe('-qB4670-aBcDeFgHiJkL')
  })

  it('preserves non-UTF-8 raw bytes (0xff)', () => {
    const encoded = '%FF%FE%FD'
    const buf = decodeAria2PeerId(encoded)
    expect(Array.from(buf)).toEqual([0xff, 0xfe, 0xfd])
  })

  it('passes through plain ascii without percent escapes', () => {
    expect(decodeAria2PeerId('abc').toString('utf8')).toBe('abc')
  })
})

describe('bitfieldProgress', () => {
  it('returns 0 for empty bitfield', () => {
    expect(bitfieldProgress('')).toBe(0)
  })

  it('returns 1 for fully-set bitfield', () => {
    expect(bitfieldProgress('ff')).toBe(1)
    expect(bitfieldProgress('ffff')).toBe(1)
  })

  it('returns 0.5 for half-set bitfield', () => {
    // 0xf0 = 1111 0000 → 4/8 = 0.5
    expect(bitfieldProgress('f0')).toBe(0.5)
  })

  it('ignores invalid hex chars without crashing', () => {
    expect(bitfieldProgress('ff??')).toBe(1)
  })
})

describe('translatePeer', () => {
  function rawPeer(overrides: Partial<Aria2RawPeer> = {}): Aria2RawPeer {
    return {
      ip: '192.168.1.10',
      port: '6881',
      peerId: '%2DqB4670%2DaBcDeFgHiJkL',
      bitfield: 'ffff',
      amChoking: 'false',
      peerChoking: 'true',
      seeder: 'false',
      downloadSpeed: '12345',
      uploadSpeed: '0',
      ...overrides,
    }
  }

  it('translates a typical qBittorrent peer', () => {
    const peer = translatePeer(rawPeer())
    expect(peer.id).toBe('192.168.1.10:6881')
    expect(peer.ip).toBe('192.168.1.10')
    expect(peer.port).toBe(6881)
    expect(peer.client).toBe('qBittorrent')
    expect(peer.progress).toBe(1)
    expect(peer.downSpeed).toBe(12345)
    expect(peer.upSpeed).toBe(0)
    expect(peer.seeder).toBe(false)
    expect(peer.peerChoking).toBe(true)
    expect(peer.amChoking).toBe(false)
  })

  it('marks unknown peerId as null client', () => {
    // 20 bytes that match no known scheme
    const peer = translatePeer(rawPeer({ peerId: 'x'.repeat(20) }))
    expect(peer.client).toBeNull()
    expect(peer.clientVersion).toBeNull()
  })

  it('handles missing/empty peerId gracefully', () => {
    const peer = translatePeer(rawPeer({ peerId: '' }))
    expect(peer.client).toBeNull()
    expect(peer.ip).toBe('192.168.1.10')
  })

  it('parses seeder and choke flags', () => {
    const peer = translatePeer(
      rawPeer({ seeder: 'true', amChoking: 'true', peerChoking: 'false' })
    )
    expect(peer.seeder).toBe(true)
    expect(peer.amChoking).toBe(true)
    expect(peer.peerChoking).toBe(false)
  })
})
