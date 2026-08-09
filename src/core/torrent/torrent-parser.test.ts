import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import { TorrentParser } from './torrent-parser'

const FIXTURE_PATH = resolve(__dirname, '__fixtures__/test.torrent')

function fixtureBase64(): string {
  return readFileSync(FIXTURE_PATH).toString('base64')
}

describe('TorrentParser', () => {
  it('parses a valid .torrent file and returns TorrentMeta', async () => {
    const parser = new TorrentParser()
    const meta = await parser.parse(fixtureBase64())

    expect(meta.name).toBe('test-torrent')
    expect(meta.infoHash).toMatch(/^[a-f0-9]{40}$/)
    expect(meta.comment).toBe('Test torrent')
    expect(meta.isPrivate).toBe(false)
  })

  it('returns 3 files with correct paths and extensions', async () => {
    const parser = new TorrentParser()
    const meta = await parser.parse(fixtureBase64())

    expect(meta.files).toHaveLength(3)

    const mkvFile = meta.files.find((f) => f.extension === '.mkv')
    expect(mkvFile).toBeDefined()
    expect(mkvFile?.path).toContain('movie.mkv')
    expect(mkvFile?.size).toBe(1048576)

    const txtFile = meta.files.find((f) => f.extension === '.txt')
    expect(txtFile).toBeDefined()
    expect(txtFile?.path).toContain('readme.txt')
    expect(txtFile?.size).toBe(2048)

    const jpgFile = meta.files.find((f) => f.extension === '.jpg')
    expect(jpgFile).toBeDefined()
    expect(jpgFile?.path).toContain('cover.jpg')
    expect(jpgFile?.size).toBe(51200)
  })

  it('assigns 0-based indices to all files', async () => {
    const parser = new TorrentParser()
    const meta = await parser.parse(fixtureBase64())

    const indices = meta.files.map((f) => f.index)
    expect(indices).toEqual([0, 1, 2])
  })

  it('computes totalSize as sum of all file sizes', async () => {
    const parser = new TorrentParser()
    const meta = await parser.parse(fixtureBase64())

    const expected = 1048576 + 2048 + 51200
    expect(meta.totalSize).toBe(expected)
  })

  it('throws AppError(TorrentParseFailed) for invalid base64 data', async () => {
    const parser = new TorrentParser()
    await expect(parser.parse('not-valid-torrent-data')).rejects.toMatchObject({
      name: 'AppError',
      code: ErrorCode.TorrentParseFailed,
    })
  })

  it('throws AppError(TorrentParseFailed) for non-torrent binary data', async () => {
    const parser = new TorrentParser()
    const garbage = Buffer.from('this is definitely not a torrent').toString(
      'base64'
    )
    await expect(parser.parse(garbage)).rejects.toMatchObject({
      name: 'AppError',
      code: ErrorCode.TorrentParseFailed,
    })
  })

  it('throws AppError(TorrentParseFailed) when base64 string is too large', async () => {
    const parser = new TorrentParser()
    // 50 MB + 1 byte of base64
    const oversized = 'A'.repeat(50 * 1024 * 1024 + 1)
    await expect(parser.parse(oversized)).rejects.toMatchObject({
      name: 'AppError',
      code: ErrorCode.TorrentParseFailed,
      message: 'Torrent file is too large',
    })
  })
})
