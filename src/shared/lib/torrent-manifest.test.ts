import { torrentManifestSchema } from '@shared/schemas/torrent-manifest'
import { describe, expect, it } from 'vitest'
import {
  manifestToEngineTorrent,
  manifestToTorrentMeta,
} from './torrent-manifest'

function fixture() {
  return {
    infoHash: 'a'.repeat(64),
    v1: null,
    v2: 'a'.repeat(64),
    name: 'folder',
    multiFile: true,
    isPrivate: false,
    verificationReady: false,
    files: [
      {
        index: 0,
        components: ['folder', 'first.bin'],
        length: 10,
        padding: false,
      },
      {
        index: 1,
        components: ['folder', '.pad', '6'],
        length: 6,
        padding: true,
      },
      {
        index: 2,
        components: ['folder', 'second.bin'],
        length: 20,
        padding: false,
      },
    ],
  }
}

describe('verified torrent manifest projection', () => {
  it('shows v2 files before proofs are ready without changing native indices', () => {
    const manifest = torrentManifestSchema.parse(fixture())
    const meta = manifestToTorrentMeta(manifest)
    expect(meta.files.map((file) => file.index)).toEqual([0, 2])
    expect(meta.totalSize).toBe(30)
    const engine = manifestToEngineTorrent(manifest)
    expect(engine.identity).toEqual({ kind: 'v2', sha256: manifest.infoHash })
    expect(engine.files?.[2].pathComponents).toEqual(['folder', 'second.bin'])
    expect(manifest.verificationReady).toBe(false)
  })

  it('rejects torn identities, escaping paths, reindexed files and unsafe lengths', () => {
    expect(
      torrentManifestSchema.safeParse({ ...fixture(), v2: 'b'.repeat(64) })
        .success
    ).toBe(false)
    for (const change of [
      { components: ['folder', '..', 'escape'] },
      { components: ['folder', 'dir/file'] },
      { index: 9 },
      { length: Number.MAX_SAFE_INTEGER },
    ]) {
      const manifest = fixture()
      Object.assign(manifest.files[0], change)
      expect(torrentManifestSchema.safeParse(manifest).success).toBe(false)
    }
  })
})
