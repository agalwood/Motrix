// Expectations adapted from libtorrent v2.0.11 test/test_torrent_info.cpp.
// Copyright (c) 2013-2022 Arvid Norberg, 2016, 2018 Alden Torres,
// 2017 Pavel Pimenov, 2017-2019 Steven Siloti, 2019 Andrei Kurushin.
// BSD-3-Clause; see fixtures/libtorrent/LICENSE.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseTorrent } from '../src/index.js'

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(
      new URL(`./fixtures/libtorrent/${name}.torrent`, import.meta.url)
    )
  )
describe('libtorrent v2.0.11 independent expectations', () => {
  it.each([
    [
      'v2',
      'hybrid',
      65536n,
      '597b180c1a170a585dfc5e85d834d69013ceda174b8f357d5bb1a0ca509faf0a',
    ],
    [
      'v2-multipiece-file',
      'hybrid',
      1048576n,
      '108ac2c3718ce722e6896edc56c4afa98f1d711ecaace7aad74fca418ebd03de',
    ],
    [
      'v2-only',
      'v2',
      1048576n,
      '95e04d0c4bad94ab206efa884666fd89777dbe4f7bd9945af1829037a85c6192',
    ],
  ])('matches %s identity and file size', (name, kind, length, sha256) => {
    const parsed = parseTorrent(fixture(name as string))
    expect(parsed.identity).toMatchObject({ kind, sha256 })
    expect(parsed.v2?.files).toHaveLength(1)
    expect(parsed.v2?.files[0]?.length).toBe(length)
  })
  it.each([1, 2, 3, 4, 5])(
    'preserves empty-file ordering in hybrid layout %i',
    (index) => {
      const parsed = parseTorrent(fixture(`empty-files-${index}`))
      expect(parsed.identity.kind).toBe('hybrid')
      expect(parsed.v2?.files).toHaveLength(6)
      expect(
        parsed.v2?.files.filter((file) => file.length === 0n)
      ).toHaveLength(4)
    }
  )
  it('retains symlink targets and invalid filename bytes for separate path mapping', () => {
    const links = parseTorrent(fixture('v2-symlinks'))
    expect(links.v2?.files.filter((file) => file.symlinkPath).length).toBe(3)
    const invalidName = parseTorrent(fixture('v2-invalid-filename'))
    expect(invalidName.v2?.files).toHaveLength(1)
  })
  it.each([
    'v2-invalid-file',
    'v2-invalid-pad-file',
    'v2-invalid-piece-layer',
    'v2-invalid-piece-layer-size',
    'v2-invalid-root-hash',
    'v2-mismatching-metadata',
    'v2-no-power2-piece',
    'v2-non-multiple-piece-layer',
    'v2-overlong-integer',
    'v2-piece-layer-invalid-file-hash',
    'v2-unordered-files',
    'v2-zero-root',
    'v2-zero-root-small',
  ])('rejects invalid vector %s', (name) => {
    expect(() => parseTorrent(fixture(name))).toThrow()
  })
  it('requires complete piece layers for metainfo, unlike libtorrent metadata-only admission', () => {
    expect(() => parseTorrent(fixture('v2-no-piece-layers'))).toThrow(
      /piece layer/
    )
  })
})
