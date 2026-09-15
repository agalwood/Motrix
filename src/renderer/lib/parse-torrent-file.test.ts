// @vitest-environment node

import { readFileSync } from 'node:fs'
import { MAX_TORRENT_FILE_SIZE } from '@shared/lib/torrent-meta'
import { describe, expect, it, vi } from 'vitest'
import { parseTorrentFile, readTorrentFile } from './parse-torrent-file'

describe('browser torrent file reading', () => {
  it('rejects an oversized File before reading or encoding it', async () => {
    const file = new File([], 'large.torrent')
    Object.defineProperty(file, 'size', { value: MAX_TORRENT_FILE_SIZE + 1 })
    const read = vi.spyOn(file, 'arrayBuffer')
    await expect(readTorrentFile(file)).rejects.toThrow(
      'Torrent file is too large'
    )
    expect(read).not.toHaveBeenCalled()
  })

  it('also bounds bytes passed directly to the parser', async () => {
    await expect(
      parseTorrentFile(new Uint8Array(MAX_TORRENT_FILE_SIZE + 1))
    ).rejects.toThrow('Torrent file is too large')
  })

  it('preserves the original file bytes in the submitted Base64', async () => {
    const bytes = readFileSync(
      new URL('../../core/torrent/__fixtures__/test.torrent', import.meta.url)
    )
    const result = await readTorrentFile(new File([bytes], 'test.torrent'))
    expect(result.base64).toBe(bytes.toString('base64'))
    expect(result.meta.name).toBe('test-torrent')
    expect(result.meta.files).toHaveLength(3)
  })

  it('validates metainfo before allocating its Base64 representation', async () => {
    const encode = vi.spyOn(globalThis, 'btoa')
    try {
      await expect(
        readTorrentFile(new File(['invalid'], 'bad.torrent'))
      ).rejects.toThrow()
      expect(encode).not.toHaveBeenCalled()
    } finally {
      encode.mockRestore()
    }
  })
})
