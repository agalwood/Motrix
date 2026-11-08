import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_ENGINE_SETTINGS } from '@core/settings/validators'
import { TorrentParser } from '@core/torrent/torrent-parser'
import {
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { expect, it } from 'vitest'
import { Aria2ConfigBuilder } from './aria2-config-builder'

it.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'adds a 78.02 GB, 7,458-file torrent whose metadata and output mappings exceed 2 MiB',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-large-torrent-'))
    let handle: Awaited<ReturnType<typeof spawnAria2ForTest>> | undefined
    let disconnect: (() => void) | undefined
    try {
      const count = 7458
      const total = 78_020_000_000
      const pieceLength = 4 * 1024 * 1024
      const names = Array.from({ length: count }, (_, index) => [
        `folder-${Math.floor(index / 100)}`,
        `${String(index).padStart(5, '0')}-${'x'.repeat(50)}.bin`,
      ])
      const files = names
        .map((parts, index) => {
          const length =
            Math.floor(total / count) +
            (index === count - 1 ? total % count : 0)
          return `d6:lengthi${length}e4:pathl${parts.map((part) => `${part.length}:${part}`).join('')}ee`
        })
        .join('')
      const pieces = Buffer.alloc(Math.ceil(total / pieceLength) * 20, 1)
      const metadata = Buffer.concat([
        Buffer.from(
          `d4:infod5:filesl${files}e4:name6:bundle12:piece lengthi${pieceLength}e6:pieces${pieces.length}:`
        ),
        pieces,
        Buffer.from('7:privatei1eee'),
      ])
      const parsed = await new TorrentParser().parse(
        metadata.toString('base64')
      )
      expect(parsed.files).toHaveLength(count)
      expect(parsed.totalSize).toBe(total)
      const outputRoot = path.join(root, 'downloads', 'bundle')
      const mappings = names.map((parts, fileIndex) => ({
        fileIndex,
        relativePath: parts.join('/'),
      }))
      const requestBytes = Buffer.byteLength(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'aria2.addTorrent',
          params: [
            metadata.toString('base64'),
            [],
            {
              'select-file': names.map((_, index) => index + 1).join(','),
              'index-out': mappings.map(
                (file) =>
                  `${file.fileIndex + 1}=${path.join(outputRoot, file.relativePath)}`
              ),
            },
          ],
        })
      )
      expect(requestBytes).toBeGreaterThan(2 * 1024 * 1024)
      // Exercise the production default, overriding a stale copied 2M config.
      const builder = new Aria2ConfigBuilder('', root)
      const args = builder.buildArgs(
        DEFAULT_ENGINE_SETTINGS,
        false,
        null,
        { download: 0, upload: 0 },
        root
      )
      handle = await spawnAria2ForTest({
        baseDir: root,
        extraArgs: [
          '--rpc-max-request-size=2M',
          ...args.filter((arg) => arg.startsWith('--rpc-max-request-size=')),
          '--enable-dht6=false',
          '--bt-enable-lpd=false',
          '--file-allocation=none',
          '--enable-sqlite3-persistence=true',
          `--sqlite3-db-path=${path.join(root, 'engine.db')}`,
        ],
      })
      const wired = await connectAdapter(handle)
      disconnect = wired.disconnect
      const start = performance.now()
      const gid = await wired.adapter.addTorrent({
        metadata,
        saveDir: path.join(root, 'metadata.state'),
        outputRoot,
        outputFilePaths: mappings,
        selectedFiles: names.map((_, index) => index + 1),
        pause: true,
        isPrivate: true,
      })
      const elapsedMs = performance.now() - start
      const result = await wired.adapter.getTaskFiles(gid)
      expect(result).toHaveLength(count)
      expect(result.every((file) => file.selected)).toBe(true)
      expect(result.at(-1)?.path).toBe(path.join(outputRoot, ...names.at(-1)!))
      expect((await wired.rpc.tellStatus(gid, ['status'])).status).toBe(
        'paused'
      )
      console.info('large-torrent regression', {
        files: count,
        metadataBytes: metadata.length,
        requestBytes,
        elapsedMs,
      })
    } finally {
      disconnect?.()
      await handle?.kill()
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000
)
