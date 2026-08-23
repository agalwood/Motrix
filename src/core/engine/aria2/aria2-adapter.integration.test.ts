// L3 integration tests — exercise Aria2Adapter against a real aria2c process
// spawned from the bundled binary. Gated on `bundledAria2Exists()` so tests
// skip cleanly on platforms without the binary (e.g. CI runners lacking the
// extra/ artifacts, or non-macOS/arm64 hosts during the current rollout).
//
// Fixtures live under `scripts/poc/fixtures/` (created in Task 0). We read
// them directly rather than duplicating them under `__fixtures__/` to keep
// the repo small; the PoC fixtures total ~1.5 MB of binary data.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStatus } from '@shared/types/task'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '../../../test-utils/aria2'
import type { Aria2Adapter } from './aria2-adapter'
import type { Aria2RpcClient } from './aria2-rpc-client'

const FIXTURE_DIR = path.resolve(__dirname, '../../../../scripts/poc/fixtures')
const SAMPLE_TORRENT = path.join(FIXTURE_DIR, 'sample.torrent')
const SAMPLE_DATA_DIR = path.join(FIXTURE_DIR, 'sample-data')
const MULTI_TORRENT = path.join(FIXTURE_DIR, 'multi.torrent')
const MULTI_DATA_DIR = path.join(FIXTURE_DIR, 'multi-data')

async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 100
): Promise<T> {
  const start = Date.now()
  let last: T | null = null
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (v !== null && v !== undefined) return v
    last = v
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms (last value: ${String(last)})`
  )
}

/**
 * Best-effort teardown so one test's leftovers do not leak into the next.
 * Neither call is an assertion here: `aria2.remove` rejects once the group has
 * already retired on its own, and `aria2.removeDownloadResult` rejects while
 * the group is still winding down. The `removeDownloadResult` test below owns
 * that ordering contract explicitly.
 */
async function discardTask(adapter: Aria2Adapter, gid: string): Promise<void> {
  try {
    await adapter.removeTask(gid)
  } catch {
    // Already out of the active list.
  }
  try {
    await adapter.removeDownloadResult(gid)
  } catch {
    // Result not published yet, or already consumed.
  }
}

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'Aria2Adapter (real aria2)',
  () => {
    let handle: Aria2Handle
    let adapter: Aria2Adapter
    let rpc: Aria2RpcClient
    let disconnectAdapter: () => void
    let baseDir: string

    beforeAll(async () => {
      baseDir = mkdtempSync(path.join(tmpdir(), 'a2-int-'))
      handle = await spawnAria2ForTest({ baseDir })
      const wired = await connectAdapter(handle)
      adapter = wired.adapter
      rpc = wired.rpc
      disconnectAdapter = wired.disconnect
    }, 30_000)

    afterAll(async () => {
      try {
        disconnectAdapter?.()
      } catch {
        // tolerate broken socket on teardown
      }
      await handle?.kill()
      if (baseDir) {
        rmSync(baseDir, { recursive: true, force: true })
      }
    })

    it('PoC-1: bt-seed-unverified reaches seeding/complete without hash verify', async () => {
      // Stage the pre-completed torrent data so aria2 has nothing to fetch.
      const stagingDir = path.join(baseDir, 'poc1-staging')
      await fs.mkdir(stagingDir, { recursive: true })
      await fs.cp(SAMPLE_DATA_DIR, path.join(stagingDir, 'sample-data'), {
        recursive: true,
      })

      const metadata = readFileSync(SAMPLE_TORRENT)
      const start = Date.now()
      const gid = await adapter.addTorrent({
        metadata: new Uint8Array(metadata),
        saveDir: stagingDir,
        btSeedUnverified: true,
        seedTime: 0,
        pause: false,
      })

      const status = await waitFor(async () => {
        const task = await adapter.getTaskStatus(gid)
        if (!task) return null
        if (
          task.status === TaskStatus.Seeding ||
          task.status === TaskStatus.Completed
        ) {
          return task
        }
        return null
      }, 1500)
      const elapsed = Date.now() - start

      expect(status.status).toMatch(/seeding|completed/)
      // Skipping hash verify on a 1 MB payload should comfortably land
      // under 1500 ms. Keep the ceiling consistent with the Task 0 PoC.
      expect(elapsed).toBeLessThan(1500)

      // Clean up so subsequent tests see a quiet active list.
      await discardTask(adapter, gid)
    }, 10_000)

    it('addTorrent select-file marks only requested files as selected', async () => {
      const stagingDir = path.join(baseDir, 'selectfile-staging')
      await fs.mkdir(stagingDir, { recursive: true })
      await fs.cp(MULTI_DATA_DIR, path.join(stagingDir, 'multi-data'), {
        recursive: true,
      })

      const metadata = readFileSync(MULTI_TORRENT)
      const gid = await adapter.addTorrent({
        metadata: new Uint8Array(metadata),
        saveDir: stagingDir,
        selectedFiles: [1],
        btSeedUnverified: true,
        seedTime: 0,
        pause: false,
      })

      const files = await waitFor(async () => {
        const result = await adapter.getTaskFiles(gid)
        return result.length === 2 ? result : null
      }, 3000)
      expect(files).toHaveLength(2)
      // AddTorrentParams is aria2-native (1-based), while TaskFile is a
      // domain model and therefore exposes 0-based indexes.
      const firstFile = files.find((f) => f.index === 0)
      const secondFile = files.find((f) => f.index === 1)
      expect(firstFile?.selected).toBe(true)
      expect(secondFile?.selected).toBe(false)

      await discardTask(adapter, gid)
    }, 10_000)

    it('onBtDownloadComplete fires for BT tasks and matches gid', async () => {
      const stagingDir = path.join(baseDir, 'btevent-staging')
      await fs.mkdir(stagingDir, { recursive: true })
      await fs.cp(MULTI_DATA_DIR, path.join(stagingDir, 'multi-data'), {
        recursive: true,
      })

      const received: string[] = []
      const unsubscribe = adapter.onBtDownloadComplete((gid) => {
        received.push(gid)
      })

      // aria2 only fires onBtDownloadComplete when a download actually
      // transitions from incomplete to complete. Pre-staged data alone is
      // not enough — it must pass through the check-integrity path. The
      // adapter does not expose `check-integrity` (it is an engine
      // internal), so we use the RPC client directly here.
      const metadata = readFileSync(MULTI_TORRENT)
      const gid = await rpc.addTorrent(
        Buffer.from(metadata).toString('base64'),
        [],
        {
          dir: stagingDir,
          'check-integrity': 'true',
          'seed-time': '0',
          pause: 'false',
        }
      )

      try {
        await waitFor(
          async () => (received.includes(gid) ? true : null),
          10_000
        )
        expect(received).toContain(gid)
      } finally {
        unsubscribe()
        await discardTask(adapter, gid)
      }
    }, 15_000)

    it('removeDownloadResult succeeds after aria2.remove on a stopped task', async () => {
      const stagingDir = path.join(baseDir, 'removeresult-staging')
      await fs.mkdir(stagingDir, { recursive: true })
      await fs.cp(SAMPLE_DATA_DIR, path.join(stagingDir, 'sample-data'), {
        recursive: true,
      })

      const metadata = readFileSync(SAMPLE_TORRENT)
      const gid = await adapter.addTorrent({
        metadata: new Uint8Array(metadata),
        saveDir: stagingDir,
        // Keep seeding instead of `seedTime: 0`. aria2.remove only accepts a
        // gid it can still find in the active/reserved lists — with a zero
        // seed time the pre-staged torrent may retire on its own first and
        // remove() then fails with "Active Download not found". Seeding holds
        // the group active until we ask for it to go away.
        btSeedUnverified: true,
        seedTime: 1,
        pause: false,
      })

      // Wait for the task to leave the "waiting" phase so aria2.remove
      // has something concrete to tear down.
      await waitFor(async () => {
        const task = await adapter.getTaskStatus(gid)
        if (!task) return null
        return task.status === TaskStatus.Seeding ||
          task.status === TaskStatus.Downloading
          ? task
          : null
      }, 5000)

      // Step 1: ask aria2 to stop the task
      await expect(adapter.removeTask(gid)).resolves.toBeUndefined()

      // aria2.remove on an active group only raises a halt request; the
      // download result appears once the group's last command retires. A
      // graceful halt does not abort a pending tracker request (only
      // forceRemove does), so the BT group first pushes a "stopped" announce
      // at udp://tracker.example.invalid — that can span several event-loop
      // passes. Wait for the result to exist instead of assuming remove() is
      // synchronous, otherwise step 2 races it and sees
      // "Could not remove download result of GID#…".
      await waitFor(async () => {
        const stopped = await rpc.tellStopped(0, 1000, ['gid'])
        return stopped.some((entry) => entry.gid === gid) ? true : null
      }, 10_000)

      // Step 2: removeDownloadResult should succeed on a stopped task
      await expect(adapter.removeDownloadResult(gid)).resolves.toBeUndefined()
    }, 30_000)
  }
)
