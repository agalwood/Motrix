import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createBtStoragePlan } from '@test-utils/legacy-bt-storage'
import { describe, expect, it } from 'vitest'
import {
  buildFinalOutputFilePaths,
  createBtDirectStoragePlan,
  getBtStorageLayout,
  parseBtFileLayout,
  shouldPrioritizeBtPreviewPieces,
} from './bt-storage-layout'

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../torrent/__fixtures__/test.torrent'
)

function singleFileTorrent(name: string): Uint8Array {
  const nameField = `4:name${Buffer.byteLength(name, 'utf8')}:${name}`
  const prefix = Buffer.from(
    `d4:infod6:lengthi1024e${nameField}12:piece lengthi16384e6:pieces20:`,
    'utf8'
  )
  return new Uint8Array(
    Buffer.concat([prefix, Buffer.alloc(20), Buffer.from('ee')])
  )
}

describe('legacy BT indexed storage layout', () => {
  it('maps a multi-file torrent below one short payload entry', async () => {
    const parsed = await parseBtFileLayout(
      new Uint8Array(readFileSync(FIXTURE_PATH))
    )
    const plan = createBtStoragePlan('task-1', '/downloads', parsed)

    expect(plan.layout.workspacePath).toMatch(
      /^\/downloads\/\.motrix\/[a-f0-9]{20}$/
    )
    expect(plan.layout).toMatchObject({
      version: 1,
      strategy: 'indexed-staging',
      payloadEntry: 'p',
      torrentRootName: 'test-torrent',
      multiFile: true,
    })
    expect(plan.outputFilePaths).toEqual([
      {
        fileIndex: 0,
        relativePath: path.join('p', 'video', 'movie.mkv'),
      },
      {
        fileIndex: 1,
        relativePath: path.join('p', 'readme.txt'),
      },
      {
        fileIndex: 2,
        relativePath: path.join('p', 'cover.jpg'),
      },
    ])
  })

  it('maps a single-file torrent to the payload entry itself', async () => {
    const parsed = await parseBtFileLayout(singleFileTorrent('large.iso'))
    const plan = createBtStoragePlan('task-2', '/downloads', parsed)

    expect(plan.outputFilePaths).toEqual([{ fileIndex: 0, relativePath: 'p' }])
    expect(
      buildFinalOutputFilePaths(
        parsed,
        '/downloads/Linux image.iso',
        plan.layout
      )
    ).toEqual([{ fileIndex: 0, relativePath: 'Linux image.iso' }])
  })

  it('prioritizes only metadata-confirmed video-only torrents', async () => {
    const video = await parseBtFileLayout(singleFileTorrent('Movie.MP4'))
    const mixed = await parseBtFileLayout(
      new Uint8Array(readFileSync(FIXTURE_PATH))
    )

    expect(shouldPrioritizeBtPreviewPieces(video)).toBe(true)
    expect(shouldPrioritizeBtPreviewPieces(mixed)).toBe(false)
  })

  it('rejects a torrent root that could escape the workspace', async () => {
    await expect(parseBtFileLayout(singleFileTorrent('..'))).rejects.toThrow(
      'Invalid torrent name'
    )
  })

  it('does not trust a persisted workspace outside the task save directory', () => {
    expect(
      getBtStorageLayout({
        saveDir: '/downloads',
        diskPath: '/etc',
        finalPath: '/downloads/file',
        instances: [
          {
            payload: {
              btStorageLayout: {
                version: 1,
                strategy: 'indexed-staging',
                workspacePath: '/etc',
                payloadEntry: 'p',
                torrentRootName: 'file',
                multiFile: false,
              },
            },
          },
        ],
      } as unknown as Parameters<typeof getBtStorageLayout>[0])
    ).toBeNull()
  })
})

describe('direct BT storage layout', () => {
  it('separates single-file payloads from engine metadata at their chosen final name', async () => {
    const parsed = await parseBtFileLayout(singleFileTorrent('original.iso'))
    const plan = createBtDirectStoragePlan(
      '/downloads/chosen.iso',
      parsed,
      '/metadata/task.torrent'
    )
    expect(plan).toEqual({
      layout: {
        version: 2,
        strategy: 'direct',
        torrentRootName: 'original.iso',
        multiFile: false,
        finalized: false,
      },
      saveDir: '/metadata/task.torrent.state',
      outputRoot: '/downloads',
      outputFilePaths: [{ fileIndex: 0, relativePath: 'chosen.iso' }],
    })
  })

  it('requires durable metadata before placing a single-file engine task', async () => {
    const parsed = await parseBtFileLayout(singleFileTorrent('original.iso'))
    expect(() =>
      createBtDirectStoragePlan('/downloads/chosen.iso', parsed)
    ).toThrow('BT requires a durable torrent metadata path')
  })

  it('separates multi-file payloads from engine control files', async () => {
    const parsed = await parseBtFileLayout(
      new Uint8Array(readFileSync(FIXTURE_PATH))
    )
    const plan = createBtDirectStoragePlan(
      '/downloads/Chosen folder',
      parsed,
      '/metadata/task.torrent'
    )
    expect(plan.saveDir).toBe('/metadata/task.torrent.state')
    expect(plan.outputRoot).toBe('/downloads/Chosen folder')
    expect(plan.outputFilePaths).toEqual([
      { fileIndex: 0, relativePath: path.join('video', 'movie.mkv') },
      { fileIndex: 1, relativePath: 'readme.txt' },
      { fileIndex: 2, relativePath: 'cover.jpg' },
    ])
    expect(plan.layout).not.toHaveProperty('workspacePath')
  })
})
