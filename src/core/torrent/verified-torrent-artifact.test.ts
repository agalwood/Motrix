import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TorrentMetaStoreImpl } from '@core/task/torrent-meta-store'
import {
  TaskInstancePhase,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, expect, it, vi } from 'vitest'
import {
  manifestRecord,
  persistTorrentManifest,
  refreshTorrentArtifact,
  removeTorrentArtifact,
  verifiedTorrentRecord,
} from './verified-torrent-artifact'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'verified-torrent-artifact-')
  )
  directories.push(directory)
  const store = new TorrentMetaStoreImpl(directory)
  const metadata = Buffer.from('verified-info-only')
  const manifest = {
    infoHash: 'a'.repeat(64),
    v1: null,
    v2: 'a'.repeat(64),
    name: 'file.bin',
    multiFile: false,
    isPrivate: false,
    verificationReady: false,
    files: [
      { index: 0, components: ['file.bin'], length: 65536, padding: false },
    ],
  }
  const metaPath = await store.persist('task-1', metadata)
  const marker = await persistTorrentManifest(
    metaPath,
    manifestRecord(manifest, metadata)
  )
  const task = makeDownloadTask({
    torrentMetaPath: metaPath,
    instances: [
      {
        instanceId: 'i1',
        motrixId: 'task-1',
        gid: 'gid-1',
        phase: TaskInstancePhase.BtDownload,
        status: TaskStatus.Completed,
        progress: 100,
        totalBytes: 65536,
        downloadedBytes: 65536,
        uploadedBytes: 0,
        diskPath: '/downloads/file.bin',
        transitionPhase: TransitionPhase.Idle,
        uris: [],
        uriHash: null,
        payload: { verifiedTorrentManifest: marker },
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  })
  return { directory, store, metadata, manifest, task }
}

it('keeps both crash snapshots readable when upgrading to complete proofs, and removes only owned artifacts', async () => {
  const { directory, store, metadata, manifest, task } = await fixture()
  const old = structuredClone(task)
  const complete = Buffer.from('verified-info-and-complete-proofs')
  const adapter = {
    getTorrentMetadata: vi.fn().mockResolvedValue({
      data: complete.toString('base64'),
      awaitingSelection: false,
      manifest: { ...manifest, verificationReady: true },
    }),
  }
  const bytes = await refreshTorrentArtifact(task, metadata, adapter, store)
  expect(Buffer.from(bytes)).toEqual(complete)
  expect(task.torrentMetaPath).not.toBe(old.torrentMetaPath)
  expect(
    (await verifiedTorrentRecord(old, await store.read(old.torrentMetaPath!)))
      ?.manifest.verificationReady
  ).toBe(false)
  expect(
    (await verifiedTorrentRecord(task, await store.read(task.torrentMetaPath!)))
      ?.manifest.verificationReady
  ).toBe(true)
  expect(JSON.stringify(task.instances[0].payload)).not.toContain('components')
  await refreshTorrentArtifact(task, bytes, adapter, store)
  expect(adapter.getTorrentMetadata).toHaveBeenCalledTimes(1)
  const other = await store.persist('other-task', Buffer.from('unrelated'))
  await removeTorrentArtifact(task, store)
  await expect(readFile(task.torrentMetaPath!)).rejects.toThrow()
  await expect(readFile(old.torrentMetaPath!)).rejects.toThrow()
  await expect(
    readFile(path.join(directory, 'task-1.torrent.manifest.json'))
  ).rejects.toThrow()
  expect(await readFile(other, 'utf8')).toBe('unrelated')
})

it('rejects changed metadata and escaping manifest paths before replay', async () => {
  const { store, metadata, task } = await fixture()
  await expect(
    verifiedTorrentRecord(task, Buffer.from('different'))
  ).rejects.toThrow('does not match')
  const record = JSON.parse(
    await readFile(`${task.torrentMetaPath}.manifest.json`, 'utf8')
  )
  record.manifest.files[0].components = ['..', 'outside']
  await writeFile(
    `${task.torrentMetaPath}.manifest.json`,
    JSON.stringify(record)
  )
  await expect(verifiedTorrentRecord(task, metadata)).rejects.toThrow('invalid')
  await removeTorrentArtifact(task, store)
})

it('keeps the current snapshot when enrichment is partial, unavailable or changes identity', async () => {
  const { store, metadata, manifest, task } = await fixture()
  const before = structuredClone(task)
  const adapter = {
    getTorrentMetadata: vi
      .fn()
      .mockResolvedValue({ data: 'eA==', awaitingSelection: false, manifest }),
  }
  expect(await refreshTorrentArtifact(task, metadata, adapter, store)).toBe(
    metadata
  )
  expect(task).toEqual(before)
  adapter.getTorrentMetadata.mockResolvedValue({
    data: 'eA==',
    awaitingSelection: false,
    manifest: {
      ...manifest,
      infoHash: 'b'.repeat(64),
      v2: 'b'.repeat(64),
      verificationReady: true,
    },
  })
  await expect(
    refreshTorrentArtifact(task, metadata, adapter, store)
  ).rejects.toThrow('different torrent')
  expect(task).toEqual(before)
})
